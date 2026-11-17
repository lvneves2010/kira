package br.com.hsi.kira;

import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import kotlin.jvm.functions.Function1;

/**
 * Voz natural da KIRA: Supertonic 2 (voz feminina "F3"), int8, rodando offline com o sherpa-onnx.
 *
 * Configuração escolhida em testes (2026-11-17):
 * - 12 passos de síntese: com 5 (padrão do sherpa) a fala sai truncada;
 * - sem semente fixa: com semente fixa apareciam trechos repetidos ("loop");
 * - frase por frase: o áudio de cada frase vai para a fila de reprodução assim que fica pronto,
 *   então a fala começa antes de a resposta inteira ser gerada.
 */
@CapacitorPlugin(name = "KiraVoz")
public class KiraVozPlugin extends Plugin {
    private static final String TAG = "KiraVoz";
    private static final String PASTA = "supertonic";
    /** Ordem do voice.bin: 0–4 = F1–F5, 5–9 = M1–M5. A F3 foi a escolhida. */
    private static final int VOZ_F3 = 2;
    private static final String PASSOS = "12";
    /** Pausa entre frases, em segundos. */
    private static final float PAUSA_ENTRE_FRASES = 0.18f;

    /** Uma fala por vez, sempre na mesma thread (o motor não é thread-safe). */
    private final ExecutorService fila = Executors.newSingleThreadExecutor();
    /** Cada fala recebe um número; "parar" avança o número e a fala antiga se encerra. */
    private final AtomicInteger falaAtual = new AtomicInteger();

    private OfflineTts tts;
    private volatile AudioTrack trilha;

    @PluginMethod
    public void preparar(PluginCall call) {
        fila.execute(() -> {
            try {
                long inicio = SystemClock.elapsedRealtime();
                carregar();
                JSObject ret = new JSObject();
                ret.put("ms", SystemClock.elapsedRealtime() - inicio);
                call.resolve(ret);
            } catch (Throwable e) {
                Log.e(TAG, "preparar falhou", e);
                call.reject("Não foi possível carregar a voz natural: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void falar(PluginCall call) {
        String texto = call.getString("texto", "");
        float velocidade = call.getFloat("velocidade", 1.0f);
        int minhaFala = falaAtual.incrementAndGet();

        fila.execute(() -> {
            if (minhaFala != falaAtual.get()) {
                call.resolve(); // "Parar" chegou antes de começar.
                return;
            }
            try {
                carregar();
                long inicio = SystemClock.elapsedRealtime();
                AudioTrack audio = novaTrilha(tts.sampleRate());
                trilha = audio;

                // Quem gera não espera quem toca: a próxima frase é gerada enquanto a anterior toca.
                Tocador tocador = new Tocador(audio, minhaFala, inicio);
                Thread threadTocador = new Thread(tocador, "KiraVoz-tocador");
                threadTocador.start();

                GenerationConfig config = configuracao(velocidade);
                AoGerarPedaco aoGerar = new AoGerarPedaco(tocador, minhaFala);
                float[] pausa = new float[(int) (tts.sampleRate() * PAUSA_ENTRE_FRASES)];

                List<String> frases = dividirEmFrases(texto);
                for (int i = 0; i < frases.size() && minhaFala == falaAtual.get(); i++) {
                    long inicioFrase = SystemClock.elapsedRealtime();
                    long amostrasAntes = tocador.totalAmostras;
                    tts.generateWithConfigAndCallback(frases.get(i), config, aoGerar);
                    if (i < frases.size() - 1) {
                        tocador.adicionar(pausa);
                    }
                    long ms = SystemClock.elapsedRealtime() - inicioFrase;
                    double segundos = (tocador.totalAmostras - amostrasAntes) / (double) tts.sampleRate();
                    Log.i(TAG, String.format(Locale.ROOT, "frase \"%s\": %.1fs de áudio em %d ms (RTF %.2f)",
                            frases.get(i), segundos, ms, ms / 1000.0 / Math.max(segundos, 0.01)));
                }

                tocador.terminar();
                threadTocador.join();
                encerrar(audio);

                Log.i(TAG, "fala: primeiro áudio em " + tocador.primeiroAudioMs + " ms, total "
                        + (SystemClock.elapsedRealtime() - inicio) + " ms");
                JSObject ret = new JSObject();
                ret.put("primeiroAudioMs", tocador.primeiroAudioMs);
                call.resolve(ret);
            } catch (Throwable e) {
                Log.e(TAG, "falar falhou", e);
                AudioTrack audio = trilha;
                if (audio != null) {
                    encerrar(audio);
                }
                call.reject("A voz natural falhou: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void parar(PluginCall call) {
        falaAtual.incrementAndGet();
        AudioTrack audio = trilha;
        if (audio != null) {
            try {
                audio.pause();
                audio.flush();
            } catch (IllegalStateException ignorada) {
                // já encerrada
            }
        }
        call.resolve();
    }

    private synchronized void carregar() {
        if (tts != null) {
            return;
        }
        AssetManager assets = getContext().getAssets();

        OfflineTtsSupertonicModelConfig supertonic = new OfflineTtsSupertonicModelConfig();
        supertonic.setDurationPredictor(PASTA + "/duration_predictor.int8.onnx");
        supertonic.setTextEncoder(PASTA + "/text_encoder.int8.onnx");
        supertonic.setVectorEstimator(PASTA + "/vector_estimator.int8.onnx");
        supertonic.setVocoder(PASTA + "/vocoder.int8.onnx");
        supertonic.setTtsJson(PASTA + "/tts.json");
        supertonic.setUnicodeIndexer(PASTA + "/unicode_indexer.bin");
        supertonic.setVoiceStyle(PASTA + "/voice.bin");

        OfflineTtsModelConfig modelo = new OfflineTtsModelConfig();
        modelo.setSupertonic(supertonic);
        modelo.setNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
        modelo.setDebug(false);
        modelo.setProvider("cpu");

        OfflineTtsConfig config = new OfflineTtsConfig();
        config.setModel(modelo);

        tts = new OfflineTts(assets, config);
        Log.i(TAG, "voz natural carregada, taxa " + tts.sampleRate() + ", vozes " + tts.numSpeakers());

        // Aquecimento silencioso: a primeira geração é sempre mais lenta.
        long inicio = SystemClock.elapsedRealtime();
        tts.generateWithConfig("Olá, estou pronta para conversar.", configuracao(1.0f));
        Log.i(TAG, "aquecimento em " + (SystemClock.elapsedRealtime() - inicio) + " ms");
    }

    private static GenerationConfig configuracao(float velocidade) {
        GenerationConfig config = new GenerationConfig();
        config.setSid(VOZ_F3);
        Map<String, String> extra = new HashMap<>();
        extra.put("lang", "pt");
        extra.put("num_steps", PASSOS);
        // O sherpa usa 1,05 por padrão; o "Normal" do menu (1,0) fica um pouco mais pausado.
        extra.put("speed", String.valueOf(velocidade * 1.05f));
        extra.put("silence_duration", "0.15");
        config.setExtra(extra);
        return config;
    }

    /** "Oi! Tudo bem? Amanhã chove." → ["Oi!", "Tudo bem?", "Amanhã chove."]. */
    static List<String> dividirEmFrases(String texto) {
        List<String> frases = new ArrayList<>();
        for (String parte : texto.trim().split("(?<=[.!?…])\\s+")) {
            String frase = parte.trim();
            if (!frase.isEmpty()) {
                frases.add(frase);
            }
        }
        if (frases.isEmpty()) {
            frases.add(texto);
        }
        return frases;
    }

    /**
     * Recebe cada pedaço de áudio gerado e manda para o tocador.
     *
     * Precisa ser uma classe com o método {@code Integer invoke(float[])} declarado:
     * a parte nativa do sherpa-onnx procura exatamente essa assinatura via JNI, e uma
     * lambda Java só teria a versão genérica {@code invoke(Object)} (o app fecha).
     */
    private final class AoGerarPedaco implements Function1<float[], Integer> {
        private final Tocador tocador;
        private final int minhaFala;

        AoGerarPedaco(Tocador tocador, int minhaFala) {
            this.tocador = tocador;
            this.minhaFala = minhaFala;
        }

        @Override
        public Integer invoke(float[] amostras) {
            if (minhaFala != falaAtual.get()) {
                return 0; // interrompe a geração
            }
            tocador.adicionar(amostras);
            return 1;
        }
    }

    /** Toca, numa thread própria, os pedaços de áudio que a geração vai produzindo. */
    private final class Tocador implements Runnable {
        private final float[] fim = new float[0];
        private final LinkedBlockingQueue<float[]> pedacos = new LinkedBlockingQueue<>();
        private final AudioTrack audio;
        private final int minhaFala;
        private final long inicio;
        volatile long primeiroAudioMs = -1;
        /** Só a thread de geração escreve; serve para medir a velocidade de geração. */
        long totalAmostras;

        Tocador(AudioTrack audio, int minhaFala, long inicio) {
            this.audio = audio;
            this.minhaFala = minhaFala;
            this.inicio = inicio;
        }

        void adicionar(float[] amostras) {
            totalAmostras += amostras.length;
            pedacos.offer(amostras);
        }

        /** Quantas amostras já foram entregues ao AudioTrack (para saber quando terminou de tocar). */
        private long amostrasEscritas;

        /**
         * Escreve em blocos de ~0,1 s: entre um e outro dá para perceber o "parar"
         * sem ficar preso num write longo numa trilha pausada.
         */
        private void escrever(float[] amostras) {
            int bloco = Math.max(1, audio.getSampleRate() / 10);
            for (int i = 0; i < amostras.length && minhaFala == falaAtual.get(); i += bloco) {
                int escritas = audio.write(amostras, i, Math.min(bloco, amostras.length - i), AudioTrack.WRITE_BLOCKING);
                if (escritas > 0) {
                    amostrasEscritas += escritas;
                }
            }
        }

        void terminar() {
            pedacos.offer(fim);
        }

        @Override
        public void run() {
            try {
                audio.play();
                while (minhaFala == falaAtual.get()) {
                    float[] amostras = pedacos.poll(200, TimeUnit.MILLISECONDS);
                    if (amostras == null) {
                        continue;
                    }
                    if (amostras == fim) {
                        // Margem de silêncio no fim, para nenhum aparelho engolir a última sílaba.
                        escrever(new float[(int) (audio.getSampleRate() * 0.2f)]);
                        esperarTerminarDeTocar(audio, minhaFala, amostrasEscritas);
                        return;
                    }
                    if (primeiroAudioMs < 0) {
                        primeiroAudioMs = SystemClock.elapsedRealtime() - inicio;
                    }
                    escrever(amostras);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IllegalStateException ignorada) {
                // trilha parada pelo "parar"
            }
        }
    }

    private static AudioTrack novaTrilha(int taxa) {
        int minimo = AudioTrack.getMinBufferSize(taxa, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
        return new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setSampleRate(taxa)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setBufferSizeInBytes(Math.max(minimo, taxa * 4 / 2)) // ~0,5 s
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
    }

    /**
     * O write() volta quando o áudio entra no buffer, não quando termina de tocar.
     * Espera a posição de reprodução alcançar tudo o que foi escrito e só então para.
     *
     * (Antes usávamos stop() + getPlayState(): o estado vira "parado" na hora do stop(),
     * a espera acabava logo e o release() descartava o fim da fala ainda no buffer.)
     */
    private void esperarTerminarDeTocar(AudioTrack audio, int minhaFala, long amostrasEscritas) {
        try {
            long limite = SystemClock.elapsedRealtime() + 1000
                    + amostrasEscritas * 1000L / Math.max(1, audio.getSampleRate());
            while (minhaFala == falaAtual.get()
                    && (audio.getPlaybackHeadPosition() & 0xFFFFFFFFL) < amostrasEscritas
                    && SystemClock.elapsedRealtime() < limite) {
                SystemClock.sleep(20);
            }
            audio.stop();
        } catch (IllegalStateException ignorada) {
            // já encerrada
        }
    }

    private void encerrar(AudioTrack audio) {
        try {
            audio.release();
        } catch (Exception ignorada) {
            // nada a fazer
        }
        if (trilha == audio) {
            trilha = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        falaAtual.incrementAndGet();
        fila.shutdownNow();
        if (tts != null) {
            tts.release();
            tts = null;
        }
    }
}

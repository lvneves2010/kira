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
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import kotlin.jvm.functions.Function1;

/**
 * Voz "Vera" da KIRA: Pocket TTS português rodando offline com o sherpa-onnx.
 *
 * A voz é clonada a partir de assets/vera/referencia.wav. O áudio é gerado em
 * pedaços e cada pedaço vai direto para o AudioTrack, então a fala começa
 * antes de a frase inteira ficar pronta.
 */
@CapacitorPlugin(name = "KiraVoz")
public class KiraVozPlugin extends Plugin {
    private static final String TAG = "KiraVoz";
    private static final String PASTA = "vera";

    /** Uma fala por vez, sempre na mesma thread (o motor não é thread-safe). */
    private final ExecutorService fila = Executors.newSingleThreadExecutor();
    /** Cada fala recebe um número; "parar" avança o número e a fala antiga se encerra. */
    private final AtomicInteger falaAtual = new AtomicInteger();

    private OfflineTts tts;
    private float[] referencia;
    private int taxaReferencia;
    private volatile AudioTrack trilha;
    /** Threads do onnxruntime (0 = automático). Só vale na primeira carga. */
    private volatile int threads;

    @PluginMethod
    public void preparar(PluginCall call) {
        threads = call.getInt("threads", 0);
        fila.execute(() -> {
            try {
                long inicio = SystemClock.elapsedRealtime();
                carregar();
                JSObject ret = new JSObject();
                ret.put("ms", SystemClock.elapsedRealtime() - inicio);
                call.resolve(ret);
            } catch (Throwable e) {
                Log.e(TAG, "preparar falhou", e);
                call.reject("Não foi possível carregar a voz Vera: " + e.getMessage());
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

                // Quem gera não espera quem toca: os pedaços vão para uma fila e uma
                // thread separada toca. Assim a frase seguinte é gerada enquanto a
                // anterior ainda está tocando.
                Tocador tocador = new Tocador(audio, minhaFala, inicio);
                Thread threadTocador = new Thread(tocador, "KiraVoz-tocador");
                threadTocador.start();

                GenerationConfig config = new GenerationConfig();
                config.setReferenceAudio(referencia);
                config.setReferenceSampleRate(taxaReferencia);
                config.setSpeed(velocidade);
                AoGerarPedaco aoGerar = new AoGerarPedaco(tocador, minhaFala);

                // Frase por frase: a primeira fica pronta logo e a fala começa mais cedo.
                for (String frase : dividirEmFrases(texto)) {
                    if (minhaFala != falaAtual.get()) {
                        break;
                    }
                    long inicioFrase = SystemClock.elapsedRealtime();
                    long amostrasAntes = tocador.totalAmostras;
                    Map<String, String> extra = new HashMap<>();
                    extra.put("max_frames", String.valueOf(maxQuadros(frase)));
                    config.setExtra(extra);
                    tts.generateWithConfigAndCallback(frase, config, aoGerar);
                    long ms = SystemClock.elapsedRealtime() - inicioFrase;
                    double segundosAudio = (tocador.totalAmostras - amostrasAntes) / (double) tts.sampleRate();
                    Log.i(TAG, String.format(java.util.Locale.ROOT, "frase \"%s\": %.1fs de áudio em %d ms (RTF %.2f)",
                            frase, segundosAudio, ms, ms / 1000.0 / Math.max(segundosAudio, 0.01)));
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
                call.reject("A voz Vera falhou: " + e.getMessage());
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

    private synchronized void carregar() throws IOException {
        if (tts != null) {
            return;
        }
        AssetManager assets = getContext().getAssets();

        OfflineTtsPocketModelConfig pocket = new OfflineTtsPocketModelConfig();
        pocket.setLmFlow(PASTA + "/lm_flow.int8.onnx");
        pocket.setLmMain(PASTA + "/lm_main.int4.onnx");
        pocket.setEncoder(PASTA + "/encoder.onnx");
        pocket.setDecoder(PASTA + "/decoder.int8.onnx");
        pocket.setTextConditioner(PASTA + "/text_conditioner.onnx");
        pocket.setVocabJson(PASTA + "/vocab.json");
        pocket.setTokenScoresJson(PASTA + "/token_scores.json");

        OfflineTtsModelConfig modelo = new OfflineTtsModelConfig();
        modelo.setPocket(pocket);
        modelo.setNumThreads(threads > 0 ? threads : Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
        modelo.setDebug(false);
        modelo.setProvider("cpu");

        OfflineTtsConfig config = new OfflineTtsConfig();
        config.setModel(modelo);

        lerReferencia(assets);
        tts = new OfflineTts(assets, config);
        Log.i(TAG, "voz Vera carregada, taxa " + tts.sampleRate());

        // Aquecimento silencioso: a primeira geração é sempre mais lenta e é nela que
        // a voz de referência é calculada (fica em cache). Melhor pagar isso agora.
        long inicio = SystemClock.elapsedRealtime();
        // (Frase com várias palavras: com uma palavra só o modelo não acha o fim da fala.)
        String fraseAquecimento = "Olá, estou pronta para conversar com você.";
        GenerationConfig aquecimento = new GenerationConfig();
        aquecimento.setReferenceAudio(referencia);
        aquecimento.setReferenceSampleRate(taxaReferencia);
        Map<String, String> extra = new HashMap<>();
        extra.put("max_frames", String.valueOf(maxQuadros(fraseAquecimento)));
        aquecimento.setExtra(extra);
        tts.generateWithConfig(fraseAquecimento, aquecimento);
        Log.i(TAG, "aquecimento em " + (SystemClock.elapsedRealtime() - inicio) + " ms");
    }

    /** Lê o WAV PCM 16 bits mono de referência e converte para float [-1, 1]. */
    private void lerReferencia(AssetManager assets) throws IOException {
        byte[] bytes;
        try (InputStream entrada = assets.open(PASTA + "/referencia.wav")) {
            ByteArrayOutputStream saida = new ByteArrayOutputStream();
            byte[] bloco = new byte[16384];
            int lidos;
            while ((lidos = entrada.read(bloco)) > 0) {
                saida.write(bloco, 0, lidos);
            }
            bytes = saida.toByteArray();
        }

        ByteBuffer wav = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        int pos = 12;
        int taxa = 24000;
        int canais = 1;
        while (pos + 8 <= bytes.length) {
            String id = new String(bytes, pos, 4, "US-ASCII");
            int tamanho = wav.getInt(pos + 4);
            if ("fmt ".equals(id)) {
                canais = wav.getShort(pos + 10);
                taxa = wav.getInt(pos + 12);
            } else if ("data".equals(id)) {
                int total = Math.min(tamanho, bytes.length - pos - 8) / 2 / canais;
                float[] amostras = new float[total];
                for (int i = 0; i < total; i++) {
                    amostras[i] = wav.getShort(pos + 8 + i * 2 * canais) / 32768f;
                }
                referencia = amostras;
                taxaReferencia = taxa;
                return;
            }
            pos += 8 + tamanho + (tamanho % 2);
        }
        throw new IOException("referencia.wav sem bloco de dados");
    }

    /**
     * Recebe cada pedaço de áudio gerado e manda para o AudioTrack.
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
        /** Só a thread de geração escreve; serve para medir o tempo real de geração. */
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
                        esperarTerminarDeTocar(audio, minhaFala);
                        return;
                    }
                    if (primeiroAudioMs < 0) {
                        primeiroAudioMs = SystemClock.elapsedRealtime() - inicio;
                    }
                    // Em blocos de ~0,1 s: entre um e outro dá para perceber o "parar"
                    // sem ficar preso num write longo numa trilha pausada.
                    int bloco = Math.max(1, audio.getSampleRate() / 10);
                    for (int i = 0; i < amostras.length && minhaFala == falaAtual.get(); i += bloco) {
                        audio.write(amostras, i, Math.min(bloco, amostras.length - i), AudioTrack.WRITE_BLOCKING);
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IllegalStateException ignorada) {
                // trilha parada pelo "parar"
            }
        }
    }

    /** Frases com mais palavras que isso são divididas também nas vírgulas. */
    private static final int FRASE_LONGA = 9;
    /**
     * Nenhum trecho sai com menos palavras que isso. Abaixo de ~6 palavras o modelo
     * português erra (corta a fala ou gera ruído), e cada chamada custa ~0,4 s fixos.
     */
    private static final int TRECHO_MINIMO = 6;

    /**
     * Divide o texto em trechos para gerar um de cada vez:
     * "Oi! Eu sou a Kira. Amanhã deve chover à tarde, então leve um guarda-chuva." →
     * ["Oi! Eu sou a Kira. Amanhã deve chover à tarde,", "então leve um guarda-chuva."].
     *
     * Pedaços curtos vão se juntando ao seguinte até chegar ao mínimo (e não mais
     * que isso, para a fala começar cedo). Neste celular o modelo gera a ~0,85× o
     * tempo real, então trechos de tamanho parecido mantêm a geração à frente do que
     * está tocando, sem pausas.
     */
    static List<String> dividirEmFrases(String texto) {
        List<String> pedacos = new ArrayList<>();
        for (String frase : texto.trim().split("(?<=[.!?…])\\s+")) {
            frase = frase.trim();
            if (frase.isEmpty()) {
                continue;
            }
            if (palavras(frase) <= FRASE_LONGA) {
                pedacos.add(frase);
            } else {
                for (String parte : frase.split("(?<=[,;:])\\s+")) {
                    if (!parte.trim().isEmpty()) {
                        pedacos.add(parte.trim());
                    }
                }
            }
        }

        List<String> trechos = new ArrayList<>();
        StringBuilder atual = new StringBuilder();
        for (String pedaco : pedacos) {
            if (atual.length() > 0) {
                atual.append(' ');
            }
            atual.append(pedaco);
            if (palavras(atual.toString()) >= TRECHO_MINIMO) {
                trechos.add(atual.toString());
                atual.setLength(0);
            }
        }
        if (atual.length() > 0) {
            // Sobra curta no fim ("tá?"): vai junto com o trecho anterior.
            int ultimo = trechos.size() - 1;
            if (ultimo >= 0) {
                trechos.set(ultimo, trechos.get(ultimo) + " " + atual);
            } else {
                trechos.add(atual.toString());
            }
        }
        if (trechos.isEmpty()) {
            trechos.add(texto);
        }
        return trechos;
    }

    static int palavras(String texto) {
        String limpo = texto.trim();
        return limpo.isEmpty() ? 0 : limpo.split("\\s+").length;
    }

    /**
     * Teto de quadros (12,5 por segundo) proporcional ao texto: se o modelo não
     * detectar o fim da fala, ele para aqui em vez de gerar até 40 s de ruído.
     */
    static int maxQuadros(String trecho) {
        double segundos = 1.5 + 0.11 * trecho.length();
        return (int) Math.ceil(segundos * 12.5);
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

    /** O write() termina quando o áudio entra no buffer; espera ele acabar de tocar. */
    private void esperarTerminarDeTocar(AudioTrack audio, int minhaFala) {
        try {
            audio.stop(); // em MODE_STREAM, toca o que resta no buffer e para
            long limite = SystemClock.elapsedRealtime() + 3000;
            while (audio.getPlayState() == AudioTrack.PLAYSTATE_PLAYING
                    && minhaFala == falaAtual.get()
                    && SystemClock.elapsedRealtime() < limite) {
                SystemClock.sleep(30);
            }
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

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TextToSpeech, SpeechSynthesisVoice } from '@capacitor-community/text-to-speech';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { environment } from '../../environments/environment';

export interface OpcaoVoz {
  /** Índice da voz na lista completa do plugin (é o que o `speak` recebe). */
  indice: number;
  /** Nome técnico da voz no motor do Android, ex.: "pt-br-x-afs-network". */
  id: string;
  rotulo: string;
  /** Vozes "network" do Google são neurais: soam bem mais naturais, mas exigem internet. */
  online: boolean;
}

export interface OpcaoVelocidade {
  valor: number;
  rotulo: string;
}

const CHAVE_VOZ = 'kira.voz';
const CHAVE_VELOCIDADE = 'kira.velocidade';
const CHAVE_LEDA = 'kira.vozLeda';
const CHAVE_COTA_LEDA = 'kira.vozLedaEsgotadaAte';
const IDIOMA = 'pt-BR';

/**
 * Voz "Leda" gerada pelo Gemini (TTS). Soa muito mais humana, mas no plano
 * gratuito o modelo de voz tem só ~10 requisições por dia por projeto.
 * Quando a cota acaba (ou falta internet), a KIRA usa a voz do aparelho.
 */
const VOZ_LEDA = {
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent',
  nome: 'Leda',
  tempoLimiteMs: 12000,
  pastaCache: 'voz-leda',
};

/**
 * Fala da KIRA. Usa a voz Leda (Gemini) quando ligada e disponível; senão,
 * o motor de voz do aparelho (Google TTS no Android), preferindo as vozes
 * neurais ("online") e, sem internet, a versão offline da mesma voz.
 */
@Injectable({ providedIn: 'root' })
export class VozService {
  readonly velocidades: OpcaoVelocidade[] = [
    { valor: 0.9, rotulo: 'Calma' },
    { valor: 1.0, rotulo: 'Normal' },
    { valor: 1.12, rotulo: 'Rápida' },
  ];

  readonly opcoes$ = new BehaviorSubject<OpcaoVoz[]>([]);
  readonly vozSelecionada$ = new BehaviorSubject<string | null>(this.ler(CHAVE_VOZ));
  readonly velocidade$ = new BehaviorSubject<number>(Number(this.ler(CHAVE_VELOCIDADE)) || 1.0);
  /** Ligada por padrão enquanto o app está em teste. */
  readonly ledaLigada$ = new BehaviorSubject<boolean>(this.ler(CHAVE_LEDA) !== 'nao');
  /** Momento (ms) até quando a cota gratuita da Leda está esgotada; 0 = disponível. */
  readonly ledaEsgotadaAte$ = new BehaviorSubject<number>(Number(this.ler(CHAVE_COTA_LEDA)) || 0);

  private carregamento?: Promise<void>;
  private audioAtual?: HTMLAudioElement;
  private pararAudioAtual?: () => void;
  /** Contador de falas: permite descartar um áudio que chegou depois do "Parar". */
  private falaAtual = 0;

  /** Carrega a lista de vozes uma vez; chamadas seguintes reaproveitam o resultado. */
  carregar(): Promise<void> {
    this.carregamento ??= this.buscarVozes().catch(err => {
      console.warn('diagnostic: VozService - não foi possível listar as vozes', err);
      this.carregamento = undefined;
    });
    return this.carregamento;
  }

  selecionarVoz(id: string): void {
    this.vozSelecionada$.next(id);
    this.gravar(CHAVE_VOZ, id);
  }

  selecionarVelocidade(valor: number): void {
    this.velocidade$.next(valor);
    this.gravar(CHAVE_VELOCIDADE, String(valor));
  }

  ligarLeda(ligada: boolean): void {
    this.ledaLigada$.next(ligada);
    this.gravar(CHAVE_LEDA, ligada ? 'sim' : 'nao');
  }

  ledaDisponivel(): boolean {
    return this.ledaLigada$.value && Date.now() >= this.ledaEsgotadaAte$.value;
  }

  /**
   * Fala o texto e só resolve quando terminar.
   * `somenteAparelho` ignora a Leda (usado na prévia das vozes do aparelho).
   */
  async falar(texto: string, somenteAparelho = false): Promise<void> {
    const fala = ++this.falaAtual;

    if (!somenteAparelho && this.ledaDisponivel() && navigator.onLine !== false) {
      const audio = await this.obterAudioLeda(texto);
      if (fala !== this.falaAtual) {
        return; // "Parar" foi tocado enquanto o áudio era gerado.
      }
      if (audio) {
        try {
          await this.tocar(audio);
          return;
        } catch (err) {
          console.warn('diagnostic: VozService - não tocou a Leda, usando a voz do aparelho', err);
        }
      }
    }
    await this.falarNoAparelho(texto);
  }

  /** Interrompe qualquer fala em andamento (Leda ou voz do aparelho). */
  async parar(): Promise<void> {
    this.falaAtual++;
    this.pararAudioAtual?.();
    await TextToSpeech.stop();
  }

  // ---------- Voz Leda (Gemini TTS) ----------

  /** Devolve o áudio (data URI) da frase, do cache ou gerado agora; `null` se não der. */
  private async obterAudioLeda(texto: string): Promise<string | null> {
    // Frases repetidas (saudações, "Lanterna ligada"...) não gastam cota de novo.
    const arquivo = `${VOZ_LEDA.pastaCache}/${this.hash(`${VOZ_LEDA.nome}|${texto}`)}.wav`;
    try {
      const { data } = await Filesystem.readFile({ path: arquivo, directory: Directory.Cache });
      if (typeof data === 'string' && data.length) {
        console.log('diagnostic: VozService - Leda do cache');
        return `data:audio/wav;base64,${data}`;
      }
    } catch {
      // Não está no cache: segue para gerar.
    }

    const gerado = await this.gerarAudioLeda(texto);
    if (!gerado) {
      return null;
    }

    try {
      await Filesystem.writeFile({
        path: arquivo,
        data: gerado.base64,
        directory: Directory.Cache,
        recursive: true,
      });
    } catch (err) {
      console.warn('diagnostic: VozService - não foi possível guardar o áudio no cache', err);
    }

    return `data:${gerado.mime};base64,${gerado.base64}`;
  }

  private async gerarAudioLeda(texto: string): Promise<{ base64: string; mime: string } | null> {
    const chave = environment.llmApiKey;
    if (!chave) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOZ_LEDA.tempoLimiteMs);

    try {
      const resposta = await fetch(`${VOZ_LEDA.url}?key=${chave}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          // O modelo de voz não aceita instrução de sistema e pode ler em voz alta
          // qualquer instrução no texto; por isso vai só a frase.
          contents: [{ parts: [{ text: texto }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOZ_LEDA.nome } } },
          },
        }),
      });
      const dados = await resposta.json();

      if (!resposta.ok) {
        console.warn('diagnostic: VozService - Leda HTTP', resposta.status, dados?.error?.message);
        if (resposta.status === 429) {
          this.marcarCotaEsgotada(dados);
        }
        return null;
      }

      const audio = dados?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData;
      if (!audio) {
        return null;
      }

      // O modelo devolve WAV; se vier PCM cru (audio/L16), embrulha num cabeçalho WAV.
      const mime: string = audio.mimeType || 'audio/wav';
      if (/l16|pcm/i.test(mime)) {
        const taxa = Number(/rate=(\d+)/.exec(mime)?.[1]) || 24000;
        return { base64: this.pcmParaWav(audio.data, taxa), mime: 'audio/wav' };
      }
      return { base64: audio.data, mime };
    } catch (err) {
      console.warn('diagnostic: VozService - Leda falhou', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Guarda até quando a cota está esgotada, usando o `retryDelay` que o Google informa. */
  private marcarCotaEsgotada(dados: any): void {
    const retry: string | undefined = dados?.error?.details?.find((d: any) => d?.retryDelay)?.retryDelay;
    const segundos = Number(/(\d+)/.exec(retry ?? '')?.[1]) || 60 * 60;
    const ate = Date.now() + segundos * 1000;
    this.ledaEsgotadaAte$.next(ate);
    this.gravar(CHAVE_COTA_LEDA, String(ate));
    console.warn('diagnostic: VozService - cota da Leda esgotada até', new Date(ate).toLocaleString('pt-BR'));
  }

  private tocar(fonte: string): Promise<void> {
    this.pararAudioAtual?.();

    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(fonte);
      this.audioAtual = audio;

      const encerrar = (erro?: unknown) => {
        audio.onended = null;
        audio.onerror = null;
        if (this.audioAtual === audio) {
          this.audioAtual = undefined;
          this.pararAudioAtual = undefined;
        }
        if (erro) {
          reject(erro);
        } else {
          resolve();
        }
      };

      this.pararAudioAtual = () => {
        audio.pause();
        encerrar();
      };
      audio.onended = () => encerrar();
      audio.onerror = () => encerrar(new Error('Falha ao tocar o áudio da voz Leda.'));
      audio.play().catch(encerrar);
    });
  }

  private pcmParaWav(base64Pcm: string, taxa: number): string {
    const pcm = Uint8Array.from(atob(base64Pcm), c => c.charCodeAt(0));
    const cabecalho = new DataView(new ArrayBuffer(44));
    const escrever = (pos: number, s: string) => [...s].forEach((c, i) => cabecalho.setUint8(pos + i, c.charCodeAt(0)));
    escrever(0, 'RIFF');
    cabecalho.setUint32(4, 36 + pcm.length, true);
    escrever(8, 'WAVE');
    escrever(12, 'fmt ');
    cabecalho.setUint32(16, 16, true);
    cabecalho.setUint16(20, 1, true); // PCM
    cabecalho.setUint16(22, 1, true); // mono
    cabecalho.setUint32(24, taxa, true);
    cabecalho.setUint32(28, taxa * 2, true);
    cabecalho.setUint16(32, 2, true);
    cabecalho.setUint16(34, 16, true);
    escrever(36, 'data');
    cabecalho.setUint32(40, pcm.length, true);

    const wav = new Uint8Array(44 + pcm.length);
    wav.set(new Uint8Array(cabecalho.buffer), 0);
    wav.set(pcm, 44);
    let binario = '';
    for (let i = 0; i < wav.length; i += 0x8000) {
      binario += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    }
    return btoa(binario);
  }

  private hash(texto: string): string {
    let h = 5381;
    for (let i = 0; i < texto.length; i++) {
      h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + texto.length.toString(36);
  }

  // ---------- Voz do aparelho ----------

  private async falarNoAparelho(texto: string): Promise<void> {
    await this.carregar();
    const voz = this.vozParaUsar();
    const opcoes = {
      text: texto,
      lang: IDIOMA,
      rate: this.velocidade$.value,
      pitch: 1.0,
      volume: 1.0,
      category: 'ambient',
      queueStrategy: 0,
    };

    try {
      await TextToSpeech.speak(voz ? { ...opcoes, voice: voz.indice } : opcoes);
    } catch (err) {
      if (!voz) {
        throw err;
      }
      // A voz escolhida falhou (ex.: voz online sem conexão): tenta com a padrão do idioma.
      console.warn('diagnostic: VozService - falha com a voz', voz.id, '- usando a padrão', err);
      await TextToSpeech.speak(opcoes);
    }
  }

  private vozParaUsar(): OpcaoVoz | undefined {
    const opcoes = this.opcoes$.value;
    if (!opcoes.length) {
      return undefined;
    }

    const escolhida = opcoes.find(v => v.id === this.vozSelecionada$.value) ?? opcoes[0];

    // Sem internet, a voz online demora e falha; troca pela versão offline da mesma voz.
    if (escolhida.online && navigator.onLine === false) {
      const base = this.codigoBase(escolhida.id);
      return opcoes.find(v => !v.online && this.codigoBase(v.id) === base) ?? opcoes.find(v => !v.online);
    }

    return escolhida;
  }

  private async buscarVozes(): Promise<void> {
    const { voices } = await TextToSpeech.getSupportedVoices();
    console.log(
      'diagnostic: VozService - vozes do aparelho:',
      JSON.stringify(voices.filter(v => this.ehPortuguesBr(v)).map(v => [v.voiceURI, v.localService]))
    );

    const doIdioma = voices.map((v, indice) => ({ v, indice })).filter(({ v }) => this.ehPortuguesBr(v));
    // "pt-BR-language" é só um apelido da voz padrão; se houver vozes nomeadas, fica de fora.
    const nomeadas = doIdioma.filter(({ v }) => !/-language$/i.test(v.voiceURI));

    const opcoes = (nomeadas.length ? nomeadas : doIdioma)
      .map(({ v, indice }) => ({
        indice,
        id: v.voiceURI,
        online: !v.localService,
        rotulo: '',
      }))
      // Online (neurais) primeiro; depois em ordem alfabética para a numeração ser estável.
      .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));

    opcoes.forEach((o, i) => {
      o.rotulo = `Voz ${i + 1} · ${o.online ? 'mais natural (online)' : 'offline'}`;
    });

    this.opcoes$.next(opcoes);
  }

  private ehPortuguesBr(v: SpeechSynthesisVoice): boolean {
    return (v.lang || '').toLowerCase().replace('_', '-') === 'pt-br';
  }

  /** "pt-br-x-afs-network" e "pt-br-x-afs-local" são a mesma voz em versões diferentes. */
  private codigoBase(id: string): string {
    return id.replace(/-(network|local)$/i, '');
  }

  private ler(chave: string): string | null {
    try {
      return localStorage.getItem(chave);
    } catch {
      return null;
    }
  }

  private gravar(chave: string, valor: string): void {
    try {
      localStorage.setItem(chave, valor);
    } catch {
      // Sem armazenamento: a escolha vale só até fechar o app.
    }
  }
}

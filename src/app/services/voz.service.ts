import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { TextToSpeech, SpeechSynthesisVoice } from '@capacitor-community/text-to-speech';
import { numerosParaFala } from './numeros-por-extenso';

/** Plugin nativo (android/.../KiraVozPlugin.java): voz natural offline (Supertonic 2) com o sherpa-onnx. */
interface KiraVozPlugin {
  preparar(): Promise<{ ms: number }>;
  falar(opcoes: { texto: string; velocidade: number }): Promise<{ primeiroAudioMs?: number }>;
  parar(): Promise<void>;
}
const KiraVoz = registerPlugin<KiraVozPlugin>('KiraVoz');

/** Qual voz a KIRA usa como principal. A voz do aparelho é sempre a reserva. */
export type ModoVoz = 'natural' | 'aparelho';

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
const CHAVE_MODO = 'kira.modoVoz';
const IDIOMA = 'pt-BR';

/**
 * Fala da KIRA. A voz principal é escolhida no menu:
 * - natural: Supertonic 2 (voz F3) rodando no próprio celular (offline, sem limite);
 * - aparelho: motor de voz do Android (Google TTS), preferindo as vozes neurais.
 * Se a principal falhar, a KIRA fala com a voz do aparelho.
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
  /** A voz natural é a padrão: offline e sem limite de uso. */
  readonly modo$ = new BehaviorSubject<ModoVoz>(this.lerModo());
  /** A voz natural só existe no app Android (no navegador cai na voz do aparelho). */
  readonly naturalSuportada = Capacitor.getPlatform() === 'android';

  private carregamento?: Promise<void>;
  /** Contador de falas: permite descartar um áudio que chegou depois do "Parar". */
  private falaAtual = 0;
  private preparoNatural?: Promise<boolean>;

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

  selecionarModo(modo: ModoVoz): void {
    this.modo$.next(modo);
    this.gravar(CHAVE_MODO, modo);
    if (modo === 'natural') {
      void this.prepararNatural();
    }
  }

  /**
   * Carrega o modelo da voz natural em segundo plano (~1–2 s na primeira vez),
   * para a primeira fala não demorar. Chamadas repetidas reaproveitam a mesma carga.
   */
  prepararNatural(): Promise<boolean> {
    if (!this.naturalSuportada) {
      return Promise.resolve(false);
    }
    this.preparoNatural ??= KiraVoz.preparar()
      .then(({ ms }) => {
        console.log('diagnostic: VozService - voz natural carregada em', ms, 'ms');
        return true;
      })
      .catch(err => {
        console.warn('diagnostic: VozService - voz natural indisponível', err);
        return false;
      });
    return this.preparoNatural;
  }

  /**
   * Fala o texto e só resolve quando terminar.
   * `somenteAparelho` usa direto a voz do aparelho (prévia das vozes do aparelho).
   */
  async falar(textoOriginal: string, somenteAparelho = false): Promise<void> {
    const fala = ++this.falaAtual;
    // Números viram palavras aqui ("1500" -> "mil e quinhentos"), com regras fixas,
    // em vez de depender da IA ou do motor de voz acertarem a leitura.
    const texto = numerosParaFala(textoOriginal);
    const modo = somenteAparelho ? 'aparelho' : this.modo$.value;

    if (modo === 'natural' && (await this.prepararNatural())) {
      if (fala !== this.falaAtual) {
        return;
      }
      try {
        const { primeiroAudioMs } = await KiraVoz.falar({ texto, velocidade: this.velocidade$.value });
        console.log('diagnostic: VozService - voz natural começou a falar em', primeiroAudioMs, 'ms');
        return;
      } catch (err) {
        console.warn('diagnostic: VozService - voz natural falhou, usando a voz do aparelho', err);
      }
    }

    await this.falarNoAparelho(texto);
  }

  /** Interrompe qualquer fala em andamento (voz natural ou do aparelho). */
  async parar(): Promise<void> {
    this.falaAtual++;
    if (this.naturalSuportada) {
      await KiraVoz.parar().catch(() => undefined);
    }
    await TextToSpeech.stop();
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

  private lerModo(): ModoVoz {
    // Quem tinha escolhido a Leda (removida na 1.3.2) volta para a voz natural.
    return this.ler(CHAVE_MODO) === 'aparelho' ? 'aparelho' : 'natural';
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

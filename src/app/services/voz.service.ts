import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TextToSpeech, SpeechSynthesisVoice } from '@capacitor-community/text-to-speech';

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
const IDIOMA = 'pt-BR';

/**
 * Fala da KIRA usando o motor de voz do aparelho (Google TTS no Android).
 * Escolhe a melhor voz pt-BR disponível, prefere as neurais ("online") e,
 * sem internet, usa a versão offline da mesma voz quando ela existe.
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

  private carregamento?: Promise<void>;

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

  async falar(texto: string): Promise<void> {
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

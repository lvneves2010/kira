import { Injectable } from '@angular/core';
import voiceCommandsData from './voice-commands.json';
import pkg from '../../../package.json';

/**
 * Comandos que a página precisa tratar por conta própria:
 * - weather/exitApp/torchOn/torchOff: trabalho nativo ou assíncrono;
 * - repeat: repetir a última resposta falada;
 * - llm: mandar a frase para a IA (a `response` serve de reserva se a IA falhar).
 */
export type AsyncCommandKind = 'weather' | 'exitApp' | 'torchOn' | 'torchOff' | 'repeat' | 'llm';

export interface VoiceCommandMatch {
  response: string;
  speak: boolean;
  /** Set when the response requires async/native work the caller must handle (e.g. weather, torch). */
  requiresAsyncHandling?: AsyncCommandKind;
  /** False when nothing matched and this is the generic fallback response. */
  matched: boolean;
}

interface VoiceCommandEntry {
  id: string;
  patterns: string[];
  response: string;
  /** Variações da resposta; uma é sorteada a cada vez para não soar repetitivo. */
  responses?: string[];
  speak?: boolean;
  /** Resposta criativa (piada, curiosidade...): melhor e mais variada vinda da IA. */
  ia?: boolean;
  dynamic?: 'time' | 'date' | 'weekday' | 'tomorrow' | 'yesterday' | 'version' | AsyncCommandKind;
}

const ASYNC_COMMAND_KINDS: ReadonlySet<string> = new Set(['weather', 'exitApp', 'torchOn', 'torchOff', 'repeat']);

const HORAS_FEMININAS: Record<number, string> = {
  0: 'meia-noite',
  1: 'uma',
  2: 'duas',
  12: 'meio-dia',
  21: 'vinte e uma',
  22: 'vinte e duas',
};

const WEEKDAYS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const FALLBACK_RESPONSE: VoiceCommandMatch = { response: 'Desculpe, não entendi', speak: true, matched: false };

/**
 * Formas de um mesmo verbo que as pessoas usam ao dar um comando
 * ("feche", "fechar", "fecha"). Tudo vira uma forma só, tanto na frase
 * falada quanto nos padrões, para não precisar escrever cada variação.
 */
const FORMAS_VERBAIS: Record<string, string[]> = {
  fecha: ['feche', 'fechar'],
  desliga: ['desligue', 'desligar'],
  liga: ['ligue', 'ligar'],
  acende: ['acenda', 'acender'],
  apaga: ['apague', 'apagar'],
  ativa: ['ative', 'ativar'],
  desativa: ['desative', 'desativar'],
  encerra: ['encerre', 'encerrar'],
  finaliza: ['finalize', 'finalizar'],
  abre: ['abra', 'abrir'],
  sai: ['saia', 'sair'],
  aumenta: ['aumente', 'aumentar'],
  diminui: ['diminua', 'diminuir'],
  abaixa: ['abaixe', 'abaixar'],
  toca: ['toque', 'tocar'],
  conta: ['conte', 'contar'],
  fala: ['fale', 'falar'],
  diz: ['diga', 'dizer'],
  repete: ['repita', 'repetir'],
  mostra: ['mostre', 'mostrar'],
  inicia: ['inicie', 'iniciar'],
  cancela: ['cancele', 'cancelar'],
  canta: ['cante', 'cantar'],
  traduz: ['traduza', 'traduzir'],
  define: ['defina', 'definir'],
  cria: ['crie', 'criar'],
  adiciona: ['adicione', 'adicionar'],
  coloca: ['coloque', 'colocar'],
  salva: ['salve', 'salvar'],
};

const FORMA_CANONICA = new Map<string, string>();
for (const [canonica, formas] of Object.entries(FORMAS_VERBAIS)) {
  formas.forEach(forma => FORMA_CANONICA.set(forma, canonica));
}

/** Sinônimos de uma palavra só. */
const SINONIMOS: Record<string, string> = {
  app: 'aplicativo',
  aplicacao: 'aplicativo',
  lanterninha: 'lanterna',
};

/** Palavras que não mudam o sentido do comando: artigos e cortesias. */
const PALAVRAS_IGNORADAS = new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'favor', 'por']);

@Injectable({ providedIn: 'root' })
export class VoiceCommandsService {
  private readonly commands = voiceCommandsData as VoiceCommandEntry[];

  /** Padrões já canonizados, calculados uma vez. */
  private readonly padroes = this.commands.map(command => ({
    command,
    padroes: command.patterns.map(p => this.canonizar(p)).filter(p => p.length > 0),
  }));

  match(normalized: string): VoiceCommandMatch {
    const words = this.canonizar(normalized);

    // Se mais de um comando casar, vence o padrão mais longo (o mais específico):
    // em "obrigado, pode fechar o app", "pode fechar o app" ganha de "obrigado".
    // Empate: fica o que vem primeiro no JSON.
    let entry: VoiceCommandEntry | undefined;
    let maiorPadrao = 0;
    for (const { command, padroes } of this.padroes) {
      for (const padrao of padroes) {
        if (padrao.length > maiorPadrao && this.containsPhrase(words, padrao)) {
          entry = command;
          maiorPadrao = padrao.length;
        }
      }
    }

    if (!entry) {
      return FALLBACK_RESPONSE;
    }

    if (entry.dynamic && ASYNC_COMMAND_KINDS.has(entry.dynamic)) {
      return {
        response: '',
        speak: entry.speak ?? true,
        requiresAsyncHandling: entry.dynamic as AsyncCommandKind,
        matched: true,
      };
    }

    if (entry.ia) {
      return { response: this.resolveResponse(entry), speak: true, requiresAsyncHandling: 'llm', matched: true };
    }

    return { response: this.resolveResponse(entry), speak: entry.speak ?? true, matched: true };
  }

  // Casa por sequência de palavras inteiras, não por substring bruta:
  // "desliga a luz" não pode acidentalmente casar com o padrão "liga a luz".
  private containsPhrase(words: string[], patternWords: string[]): boolean {
    if (patternWords.length === 0 || patternWords.length > words.length) {
      return false;
    }

    for (let start = 0; start <= words.length - patternWords.length; start++) {
      const matches = patternWords.every((word, offset) => words[start + offset] === word);
      if (matches) {
        return true;
      }
    }

    return false;
  }

  /** "Feche o app, por favor" → ["fecha", "aplicativo"]. */
  private canonizar(frase: string): string[] {
    return frase
      .split(' ')
      .filter(Boolean)
      .filter(p => !PALAVRAS_IGNORADAS.has(p))
      .map(p => SINONIMOS[p] ?? FORMA_CANONICA.get(p) ?? p);
  }

  private resolveResponse(entry: VoiceCommandEntry): string {
    const now = new Date();

    switch (entry.dynamic) {
      case 'time':
        return this.formatTime(now);
      case 'date':
        return `Hoje é dia ${this.formatDate(now)}.`;
      case 'weekday':
        return `Hoje é ${WEEKDAYS[now.getDay()]}.`;
      case 'tomorrow': {
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        return `Amanhã será dia ${this.formatDate(tomorrow)}.`;
      }
      case 'yesterday': {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        return `Ontem foi dia ${this.formatDate(yesterday)}.`;
      }
      case 'version':
        return `Estou na versão ${pkg.version} do aplicativo.`;
      default:
        if (entry.responses?.length) {
          return entry.responses[Math.floor(Math.random() * entry.responses.length)];
        }
        return entry.response;
    }
  }

  // Hora do jeito que se fala: "Agora é uma e cinco", "Agora são três em ponto", "Agora é meio-dia e meia".
  private formatTime(date: Date): string {
    const h = date.getHours();
    const m = date.getMinutes();

    // Horas são femininas: o sintetizador leria "1" como "um" e "22" como "vinte e dois".
    const hora = HORAS_FEMININAS[h] ?? String(h);
    const verbo = h === 0 || h === 1 || h === 12 ? 'É' : 'São';
    let minutos: string;
    if (m === 0) {
      minutos = ' em ponto';
    } else if (m === 30) {
      minutos = ' e meia';
    } else {
      minutos = ` e ${m}`;
    }

    return `Agora ${verbo.toLowerCase()} ${hora}${minutos}.`;
  }

  private formatDate(date: Date): string {
    return `${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()}`;
  }
}

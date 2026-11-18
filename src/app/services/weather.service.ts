import { Injectable, inject } from '@angular/core';
import { LocalizacaoService } from './localizacao.service';
import { PedidoTempo } from './pedidos-de-local';

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: 'céu limpo',
  1: 'poucas nuvens',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'neblina',
  48: 'neblina com geada',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa forte',
  56: 'garoa congelante fraca',
  57: 'garoa congelante forte',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  66: 'chuva congelante fraca',
  67: 'chuva congelante forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  77: 'granizo fino',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes',
  85: 'pancadas de neve fracas',
  86: 'pancadas de neve fortes',
  95: 'tempestade',
  96: 'tempestade com granizo fraco',
  99: 'tempestade com granizo forte',
};

const DIAS_DA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

interface OpenMeteoResponse {
  current_weather: { temperature: number; weathercode: number };
  daily: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
  };
}

interface Dia {
  rotulo: string;
  codigo: number;
  descricao: string;
  max: number;
  min: number;
  chanceDeChuva: number | null;
}

const PADRAO: PedidoTempo = { dias: [0], diaExplicito: false, foco: 'geral' };

@Injectable({ providedIn: 'root' })
export class WeatherService {
  private readonly localizacao = inject(LocalizacaoService);

  /** Responde à pergunta sobre o tempo: aqui ou numa cidade, num dia, sobre chuva, sol, frio... */
  async responder(pedido: PedidoTempo = PADRAO): Promise<string> {
    let lat: number;
    let lon: number;
    let prefixo = '';

    if (pedido.cidade) {
      // A posição só melhora a escolha entre cidades homônimas; sem ela, segue igual.
      const perto = await this.localizacao.obterPosicao().catch(() => undefined);
      const lugar = await this.localizacao.geocodificar(pedido.cidade, perto);
      if (!lugar) {
        return `Não encontrei a cidade ${pedido.cidade}. Pode repetir o nome?`;
      }
      ({ lat, lon } = lugar);
      prefixo = `Em ${lugar.descricao}: `;
    } else {
      ({ lat, lon } = await this.localizacao.obterPosicao());
    }

    const dados = await this.fetchForecast(lat, lon);
    const resposta = this.formatar(dados, pedido);
    return prefixo ? prefixo + resposta.charAt(0).toLowerCase() + resposta.slice(1) : resposta;
  }

  /** Compatibilidade: resumo geral para o local atual. */
  getForecastSummary(): Promise<string> {
    return this.responder(PADRAO);
  }

  private async fetchForecast(latitude: number, longitude: number): Promise<OpenMeteoResponse> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=7';

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Não foi possível consultar o serviço de previsão do tempo agora.');
    }

    return response.json();
  }

  private formatar(data: OpenMeteoResponse, pedido: PedidoTempo): string {
    const dias = pedido.dias.filter(d => d < data.daily.time.length);
    if (dias.length === 0) {
      return 'Só tenho a previsão para os próximos sete dias.';
    }

    // Pergunta genérica ("previsão do tempo", "como está o tempo"): agora + próximos dias.
    if (pedido.foco === 'geral' && !pedido.diaExplicito) {
      return this.resumoGeral(data);
    }

    const partes = dias.map(i => this.responderDia(this.dia(data, i), pedido.foco));
    if (dias.includes(0) && (pedido.foco === 'temperatura' || pedido.foco === 'frio' || pedido.foco === 'calor')) {
      partes.unshift(`Agora está fazendo ${Math.round(data.current_weather.temperature)} graus.`);
    }
    return partes.join(' ');
  }

  private resumoGeral(data: OpenMeteoResponse): string {
    const hoje = this.dia(data, 0);
    const partes = [
      `Agora está ${this.describeWeatherCode(data.current_weather.weathercode)}, com ${Math.round(data.current_weather.temperature)} graus.`,
      `Hoje a máxima é de ${hoje.max} e a mínima de ${hoje.min} graus${this.falarChance(hoje)}.`,
    ];
    for (let i = 1; i < Math.min(3, data.daily.time.length); i++) {
      const d = this.dia(data, i);
      partes.push(`Para ${d.rotulo}, previsão de ${d.descricao}, com mínima de ${d.min} e máxima de ${d.max} graus.`);
    }
    return partes.join(' ');
  }

  private responderDia(d: Dia, foco: PedidoTempo['foco']): string {
    const temperaturas = `A mínima é de ${d.min} e a máxima de ${d.max} graus.`;
    const chance = d.chanceDeChuva ?? 0;
    const chuvoso = this.ehChuva(d.codigo);

    switch (foco) {
      case 'chuva':
        if (chuvoso || chance >= 60) {
          return capitalizar(`sim, ${d.rotulo} deve chover: previsão de ${d.descricao}${this.falarChance(d)}.`);
        }
        if (chance >= 30) {
          return capitalizar(`pode ser que chova ${d.rotulo}: a chance é de ${chance} por cento. A previsão é de ${d.descricao}.`);
        }
        return capitalizar(`não deve chover ${d.rotulo}${d.chanceDeChuva !== null ? `, a chance é de só ${chance} por cento` : ''}. A previsão é de ${d.descricao}.`);

      case 'sol':
        if (d.codigo <= 1 && chance < 40) {
          return capitalizar(`sim, ${d.rotulo} deve fazer sol, com ${d.descricao}. ${temperaturas}`);
        }
        if (d.codigo === 2 && chance < 40) {
          return capitalizar(`${d.rotulo} deve ter sol entre nuvens. ${temperaturas}`);
        }
        if (chuvoso || chance >= 50) {
          return capitalizar(`não, ${d.rotulo} a previsão é de ${d.descricao}${this.falarChance(d)}. ${temperaturas}`);
        }
        return capitalizar(`não muito, ${d.rotulo} deve ficar ${d.descricao}. ${temperaturas}`);

      case 'frio':
        if (d.max <= 18 || d.min <= 12) {
          return capitalizar(`sim, ${d.rotulo} vai fazer frio. ${temperaturas}`);
        }
        if (d.min <= 16) {
          return capitalizar(`${d.rotulo} vai ficar fresquinho, principalmente de manhã e à noite. ${temperaturas}`);
        }
        return capitalizar(`não, ${d.rotulo} não deve fazer frio. ${temperaturas}`);

      case 'calor':
        if (d.max >= 30) {
          return capitalizar(`sim, ${d.rotulo} vai fazer calor. ${temperaturas}`);
        }
        if (d.max >= 26) {
          return capitalizar(`${d.rotulo} vai ficar quentinho. ${temperaturas}`);
        }
        return capitalizar(`não, ${d.rotulo} deve ser um dia ameno. ${temperaturas}`);

      case 'temperatura':
        return capitalizar(`${d.rotulo}, a mínima é de ${d.min} e a máxima de ${d.max} graus.`);

      default:
        return capitalizar(`${d.rotulo}, previsão de ${d.descricao}, com mínima de ${d.min} e máxima de ${d.max} graus${this.falarChance(d)}.`);
    }
  }

  private dia(data: OpenMeteoResponse, i: number): Dia {
    const d = data.daily;
    const codigo = d.weathercode[i];
    return {
      rotulo: this.rotulo(d.time[i], i),
      codigo,
      descricao: this.describeWeatherCode(codigo),
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
      chanceDeChuva: d.precipitation_probability_max?.[i] ?? null,
    };
  }

  private rotulo(dataIso: string, i: number): string {
    if (i === 0) return 'hoje';
    if (i === 1) return 'amanhã';
    if (i === 2) return 'depois de amanhã';
    // "2026-11-21" ao meio-dia, para não virar o dia por causa do fuso.
    const dia = new Date(`${dataIso}T12:00:00`).getDay();
    return `${dia === 0 || dia === 6 ? 'no' : 'na'} ${DIAS_DA_SEMANA[dia]}`;
  }

  private falarChance(d: Dia): string {
    return d.chanceDeChuva === null || d.chanceDeChuva < 10 ? '' : `, com ${d.chanceDeChuva} por cento de chance de chuva`;
  }

  private ehChuva(codigo: number): boolean {
    return (codigo >= 51 && codigo <= 67) || (codigo >= 80 && codigo <= 82) || codigo >= 95;
  }

  private describeWeatherCode(code: number): string {
    return WEATHER_DESCRIPTIONS[code] ?? 'tempo estável';
  }
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

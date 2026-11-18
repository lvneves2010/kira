/**
 * Entende perguntas que dependem de onde o usuário está:
 * "quanto tempo daqui até a avenida paulista?", "qual a distância daqui até porto alegre?",
 * "tem uma farmácia próxima daqui?", "como chego no parque ibirapuera?" e
 * "hoje vai fazer sol aqui?".
 *
 * Recebe a frase já normalizada (minúsculas, sem acentos e sem pontuação), como
 * sai do `normalizeTranscript` da home. Não faz nenhuma chamada de rede.
 */

export type ModoViagem = 'carro' | 'a_pe' | 'bicicleta' | 'transporte';

export interface CategoriaLugar {
  /** Como a KIRA fala: "farmácia", "posto de combustível". */
  nome: string;
  artigo: 'o' | 'a';
  /** Palavras que identificam a categoria na frase (normalizadas, sem acento). */
  palavras: string[];
  /** Filtros do Overpass (OpenStreetMap), ex.: `["amenity"="pharmacy"]`. */
  filtros: string[];
  /** Termo para buscar no Google Maps quando o OpenStreetMap não achar nada. */
  busca: string;
}

export interface PedidoTempo {
  /** 0 = hoje, 1 = amanhã... (até 6, limite da previsão consultada). */
  dias: number[];
  /** O usuário disse o dia ("hoje", "amanhã", "no sábado")? */
  diaExplicito: boolean;
  cidade?: string;
  foco: 'chuva' | 'sol' | 'frio' | 'calor' | 'temperatura' | 'geral';
}

export type PedidoLocal =
  | { tipo: 'distancia'; destino: string; origem?: string; foco: 'tempo' | 'distancia'; modo: ModoViagem }
  | { tipo: 'rota'; destino: string; modo: ModoViagem }
  | { tipo: 'proximo'; categoria: CategoriaLugar | null; termo: string }
  | { tipo: 'abrirMapa' }
  | { tipo: 'tempo'; pedido: PedidoTempo };

// Ordem importa: as mais específicas primeiro ("posto de saúde" antes de "posto").
export const CATEGORIAS: CategoriaLugar[] = [
  { nome: 'farmácia', artigo: 'a', palavras: ['farmacia', 'farmacias', 'drogaria', 'drogarias'], filtros: ['["amenity"="pharmacy"]'], busca: 'farmácia' },
  { nome: 'posto de saúde', artigo: 'o', palavras: ['posto de saude', 'postinho de saude', 'postinho', 'ubs', 'unidade basica de saude'], filtros: ['["amenity"="clinic"]', '["healthcare"="centre"]'], busca: 'posto de saúde' },
  { nome: 'hospital', artigo: 'o', palavras: ['hospital', 'hospitais', 'pronto socorro', 'pronto-socorro', 'upa'], filtros: ['["amenity"="hospital"]'], busca: 'hospital' },
  { nome: 'posto de combustível', artigo: 'o', palavras: ['posto de gasolina', 'postos de gasolina', 'posto de combustivel', 'postos de combustivel', 'posto'], filtros: ['["amenity"="fuel"]'], busca: 'posto de combustível' },
  { nome: 'caixa eletrônico', artigo: 'o', palavras: ['caixa eletronico', 'caixas eletronicos', 'caixa 24 horas', 'caixa 24h', 'banco 24 horas'], filtros: ['["amenity"="atm"]'], busca: 'caixa eletrônico' },
  { nome: 'banco', artigo: 'o', palavras: ['banco', 'bancos', 'agencia bancaria'], filtros: ['["amenity"="bank"]'], busca: 'banco' },
  { nome: 'supermercado', artigo: 'o', palavras: ['supermercado', 'supermercados', 'mercado', 'mercados', 'mercadinho'], filtros: ['["shop"="supermarket"]'], busca: 'supermercado' },
  { nome: 'padaria', artigo: 'a', palavras: ['padaria', 'padarias'], filtros: ['["shop"="bakery"]'], busca: 'padaria' },
  { nome: 'pizzaria', artigo: 'a', palavras: ['pizzaria', 'pizzarias'], filtros: ['["cuisine"="pizza"]'], busca: 'pizzaria' },
  { nome: 'lanchonete', artigo: 'a', palavras: ['lanchonete', 'lanchonetes', 'hamburgueria', 'fast food'], filtros: ['["amenity"="fast_food"]'], busca: 'lanchonete' },
  { nome: 'restaurante', artigo: 'o', palavras: ['restaurante', 'restaurantes', 'lugar para comer', 'lugar pra comer'], filtros: ['["amenity"="restaurant"]'], busca: 'restaurante' },
  { nome: 'sorveteria', artigo: 'a', palavras: ['sorveteria', 'sorveterias'], filtros: ['["amenity"="ice_cream"]'], busca: 'sorveteria' },
  { nome: 'cafeteria', artigo: 'a', palavras: ['cafeteria', 'cafeterias', 'cafe'], filtros: ['["amenity"="cafe"]'], busca: 'cafeteria' },
  { nome: 'bar', artigo: 'o', palavras: ['bar', 'bares', 'boteco', 'botequim'], filtros: ['["amenity"="bar"]', '["amenity"="pub"]'], busca: 'bar' },
  { nome: 'açougue', artigo: 'o', palavras: ['acougue', 'acougues'], filtros: ['["shop"="butcher"]'], busca: 'açougue' },
  { nome: 'loja de conveniência', artigo: 'a', palavras: ['loja de conveniencia', 'conveniencia'], filtros: ['["shop"="convenience"]'], busca: 'loja de conveniência' },
  { nome: 'casa lotérica', artigo: 'a', palavras: ['casa loterica', 'loterica', 'lotericas'], filtros: ['["shop"="lottery"]'], busca: 'lotérica' },
  { nome: 'agência dos Correios', artigo: 'a', palavras: ['agencia dos correios', 'correios', 'correio'], filtros: ['["amenity"="post_office"]'], busca: 'Correios' },
  { nome: 'delegacia', artigo: 'a', palavras: ['delegacia', 'delegacias', 'posto policial'], filtros: ['["amenity"="police"]'], busca: 'delegacia' },
  { nome: 'shopping', artigo: 'o', palavras: ['shopping center', 'shopping', 'shoppings'], filtros: ['["shop"="mall"]'], busca: 'shopping' },
  { nome: 'estacionamento', artigo: 'o', palavras: ['estacionamento', 'estacionamentos'], filtros: ['["amenity"="parking"]'], busca: 'estacionamento' },
  { nome: 'hotel', artigo: 'o', palavras: ['hotel', 'hoteis', 'pousada', 'pousadas'], filtros: ['["tourism"="hotel"]', '["tourism"="guest_house"]'], busca: 'hotel' },
  { nome: 'academia', artigo: 'a', palavras: ['academia', 'academias'], filtros: ['["leisure"="fitness_centre"]'], busca: 'academia' },
  { nome: 'clínica veterinária', artigo: 'a', palavras: ['clinica veterinaria', 'veterinario', 'veterinaria'], filtros: ['["amenity"="veterinary"]'], busca: 'veterinário' },
  { nome: 'pet shop', artigo: 'o', palavras: ['pet shop', 'petshop', 'pet shops'], filtros: ['["shop"="pet"]'], busca: 'pet shop' },
  { nome: 'borracharia', artigo: 'a', palavras: ['borracharia', 'borracharias'], filtros: ['["shop"="tyres"]'], busca: 'borracharia' },
  { nome: 'oficina mecânica', artigo: 'a', palavras: ['oficina mecanica', 'oficinas mecanicas', 'mecanico', 'oficina'], filtros: ['["shop"="car_repair"]'], busca: 'oficina mecânica' },
  { nome: 'banheiro público', artigo: 'o', palavras: ['banheiro publico', 'banheiro', 'banheiros'], filtros: ['["amenity"="toilets"]'], busca: 'banheiro público' },
  { nome: 'ponto de ônibus', artigo: 'o', palavras: ['ponto de onibus', 'pontos de onibus', 'parada de onibus'], filtros: ['["highway"="bus_stop"]'], busca: 'ponto de ônibus' },
  { nome: 'estação de metrô', artigo: 'a', palavras: ['estacao de metro', 'estacoes de metro', 'metro'], filtros: ['["station"="subway"]'], busca: 'estação de metrô' },
  { nome: 'igreja', artigo: 'a', palavras: ['igreja', 'igrejas'], filtros: ['["amenity"="place_of_worship"]'], busca: 'igreja' },
];

const PROXIMIDADE = /\b(proxim[oa]s?|perto|pertinho|redondezas?|arredores|vizinhanca|por aqui|aqui do lado)\b/;
const ONDE_TEM = /\bonde (tem|ha|encontro|acho|fica|posso (encontrar|achar)|eu (encontro|acho|posso))\b/;

/** Expressões de meio de transporte, que saem do nome do destino. */
const MODOS: { re: RegExp; modo: ModoViagem }[] = [
  { re: /\b(a pe|andando|caminhando|de a pe)\b/, modo: 'a_pe' },
  { re: /\b(de bicicleta|de bike|pedalando)\b/, modo: 'bicicleta' },
  { re: /\b(de onibus|de metro|de trem|de transporte publico|de busao)\b/, modo: 'transporte' },
  { re: /\b(de carro|dirigindo|de moto|de uber|de taxi|de automovel)\b/, modo: 'carro' },
];

/** Palavras soltas que não fazem parte do nome do lugar. */
const RUIDO =
  /\b(por favor|kira|agora|hoje|mais ou menos|aproximadamente|exatamente|em media|de verdade|voce sabe|voce pode me dizer|me diz|me fala|me diga)\b/g;

/** Referências ao lugar onde o usuário está. */
const AQUI = '(?:daqui|de aqui|de onde (?:eu )?estou|da onde (?:eu )?estou|de onde estamos|da minha localizacao|de mim)';

const DESTINOS_VAZIOS = new Set(['', 'aqui', 'la', 'ali', 'ca', 'lugar', 'local', 'esse lugar', 'este lugar']);

export function interpretarPedidoDeLocal(fraseNormalizada: string): PedidoLocal | null {
  const frase = ` ${fraseNormalizada.toLowerCase().replace(/\s+/g, ' ').trim()} `;

  // 1) Lugar próximo: "tem uma farmácia perto daqui?", "onde fica o posto mais próximo?"
  const categoria = encontrarCategoria(frase);
  if (categoria && (PROXIMIDADE.test(frase) || ONDE_TEM.test(frase))) {
    return { tipo: 'proximo', categoria, termo: categoria.busca };
  }

  // 2) Abrir o mapa / traçar rota.
  const rota = interpretarRota(frase);
  if (rota) {
    return rota;
  }

  // 3) Distância ou tempo de viagem.
  return interpretarDistancia(frase);
}

export function encontrarCategoria(texto: string): CategoriaLugar | null {
  const frase = ` ${normalizar(texto)} `;
  return CATEGORIAS.find(c => c.palavras.some(p => frase.includes(` ${p} `))) ?? null;
}

const ROTA =
  /\b(como (?:eu )?(?:chego|faco (?:para|pra) (?:chegar|ir)|vou|posso chegar|posso ir)|me (?:leva|leve)|leva-me|(?:me )?(?:mostra|mostre|mostrar) o caminho|(?:traca|trace|tracar|faz|faca|fazer) (?:a |uma )?rota|rota (?:para|pra|ate)|(?:navega|navegar|navegacao) (?:para|pra|ate)|(?:abre|abra|abrir) (?:o )?(?:mapa|maps|google maps|waze)|(?:mostra|mostre|mostrar) no mapa|caminho (?:para|pra|ate)|quero ir)\b/;

function interpretarRota(frase: string): PedidoLocal | null {
  const m = ROTA.exec(frase);
  if (!m) {
    return null;
  }

  const { texto, modo } = extrairModo(frase.slice(m.index + m[0].length));
  const abreMapa = /\b(mapa|maps|waze)\b/.test(m[0]);
  // "como vou fazer um bolo" não é rota: fora do "abre o mapa", o destino vem depois de uma preposição.
  if (!abreMapa && !/^\s*(?:(?:ate|para|pra|pro|na|no|nas|nos|em|ao|aos|a|as)\s|la\s*$|ali\s*$|$)/.test(texto)) {
    return null;
  }
  const destino = limparDestino(texto.replace(/^\s*(?:ate|para|pra|pro|na|no|nas|nos|em|ao|aos|a|as|com|o)\s+/, ''));
  if (!destino) {
    // "abre o mapa", "como chego lá?": usa o último destino que a KIRA calculou.
    return { tipo: 'abrirMapa' };
  }
  return { tipo: 'rota', destino, modo };
}

function interpretarDistancia(frase: string): PedidoLocal | null {
  const focoDistancia =
    /\bdistancia\b/.test(frase) ||
    /\bquantos? (quilometros?|km|kms|metros)\b/.test(frase) ||
    /\b(fica|e|esta|ficam|sao) (muito |mais )?longe\b/.test(frase) ||
    /\b(quao|tao) longe\b/.test(frase) ||
    /\blonge daqui\b/.test(frase);

  const perguntaDeTempo = /\b(quanto tempo|quantas horas|quantos minutos|em quanto tempo)\b/.test(frase);
  const contextoDeViagem =
    new RegExp(`\\b${AQUI}\\b`).test(frase) ||
    /\b(leva|levo|levaria|demora|demoro|demoraria|gasto|gasta|gastaria|chegar|chego|chegaria|ir|viagem|dirigindo)\b/.test(frase) ||
    MODOS.some(({ re }) => re.test(frase));
  // "quanto tempo falta para o natal" não é viagem.
  const focoTempo = perguntaDeTempo && contextoDeViagem && !(/\bfalta/.test(frase) && !frase.includes('daqui'));

  if (!focoDistancia && !focoTempo) {
    return null;
  }

  const { texto, modo } = extrairModo(frase);
  const lugares = extrairOrigemEDestino(texto);
  if (!lugares) {
    return null;
  }

  return { tipo: 'distancia', ...lugares, foco: focoTempo ? 'tempo' : 'distancia', modo };
}

function extrairModo(texto: string): { texto: string; modo: ModoViagem } {
  let modo: ModoViagem = 'carro';
  let resto = texto;
  for (const { re, modo: m } of MODOS) {
    if (re.test(resto)) {
      if (modo === 'carro') {
        modo = m;
      }
      resto = resto.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  return { texto: resto.replace(/\s+/g, ' '), modo };
}

function extrairOrigemEDestino(texto: string): { destino: string; origem?: string } | null {
  const frase = texto.replace(RUIDO, ' ').replace(/\s+/g, ' ');

  // "daqui até X", "de onde estou para X"
  const aqui = new RegExp(`\\b${AQUI}\\s+(?:ate|pra|para|pro|a|ao|na|no|em)\\s+(.+)$`).exec(frase);
  if (aqui) {
    const destino = limparDestino(aqui[1]);
    return destino ? { destino } : null;
  }

  // "de São Paulo até Porto Alegre"
  const deAte = /\b(?:de|do|da|desde)\s+(.+?)\s+(?:ate|pra|para|pro)\s+(.+)$/.exec(frase);
  if (deAte) {
    const origem = limparDestino(deAte[1]);
    const destino = limparDestino(deAte[2]);
    if (destino && origem && !/^(onde|mim|minha localizacao)\b/.test(origem)) {
      return { origem, destino };
    }
  }

  // "... até X", "quanto tempo pra chegar na X"
  const ate = /\b(?:ate|pra|para|pro|ao)\s+(.+)$/.exec(frase);
  if (ate) {
    let resto = ate[1];
    // Tira verbos encadeados: "para chegar até a X", "pra ir na X".
    for (let i = 0; i < 3; i++) {
      const sem = resto.replace(/^(?:chegar|ir|andar|dirigir|viajar|voltar|eu chegar|eu ir)\s+(?:ate|na|no|em|a|ao|pra|para|pro|nas|nos|as|aos)\s+/, '');
      if (sem === resto) {
        break;
      }
      resto = sem;
    }
    const destino = limparDestino(resto);
    if (destino) {
      return { destino };
    }
  }

  // "a paulista fica longe daqui?", "porto alegre é muito longe?"
  const longe = /^\s*(?:sera que |e verdade que )?(.+?)\s+(?:fica|e|esta|ficam|sao)\s+(?:muito |mais )?longe\b/.exec(frase);
  if (longe) {
    const destino = limparDestino(longe[1]);
    if (destino) {
      return { destino };
    }
  }

  // "a que distância fica X", "quão longe fica X", "qual a distância da paulista"
  const fica = /\b(?:fica|esta|e)\s+(?!longe\b)(.+)$/.exec(frase) ?? /\bdistancia (?:d[aoe]s?|ate)\s+(.+)$/.exec(frase);
  if (fica) {
    const destino = limparDestino(fica[1]);
    if (destino) {
      return { destino };
    }
  }

  return null;
}

function limparDestino(texto: string): string | null {
  let destino = ` ${texto} `
    .replace(RUIDO, ' ')
    .replace(new RegExp(`\\b${AQUI}\\b`, 'g'), ' ')
    .replace(/\b(fica longe|e longe|e muito longe|mais proxim[oa]|de carro)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Artigos e preposições soltos no começo ou no fim.
  for (let i = 0; i < 3; i++) {
    destino = destino
      .replace(/^(?:a|o|as|os|na|no|nas|nos|em|ate|ao|aos|pra|para|pro|um|uma)\s+/, '')
      .replace(/\s+(?:a|o|de|da|do|em|ate|e|fica|esta|longe|la|ai)$/, '')
      .trim();
  }

  return DESTINOS_VAZIOS.has(destino) ? null : destino;
}

// ---------------------------------------------------------------------------
// Previsão do tempo
// ---------------------------------------------------------------------------

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

/** Lugares que não são cidade: "vai chover na rua?" fala da localização atual. */
const NAO_E_CIDADE = new Set([
  'aqui', 'ca', 'la fora', 'rua', 'casa', 'minha casa', 'minha cidade', 'minha regiao', 'regiao', 'cidade',
  'praia', 'trabalho', 'escola', 'cidade toda', 'semana', 'parte da manha', 'parte da tarde',
]);

/** "vai chover em porto alegre amanhã?" → { dias: [1], cidade: 'porto alegre', foco: 'chuva' } */
export function interpretarPedidoDoTempo(fraseNormalizada: string, hoje = new Date()): PedidoTempo {
  let frase = ` ${normalizar(fraseNormalizada)} `;

  const foco: PedidoTempo['foco'] = /\b(chuva|chuvas|chover|chovendo|chuvoso|chuvosa|garoa|garoar|guarda chuva|guarda-chuva|tempestade)\b/.test(frase)
    ? 'chuva'
    : /\b(sol|ensolarado|ensolarada|solzinho|ceu limpo|ceu aberto)\b/.test(frase)
      ? 'sol'
      : /\b(frio|fria|esfriar|gelado|congelando|friozinho)\b/.test(frase)
        ? 'frio'
        : /\b(calor|quente|esquentar|calorao|abafado)\b/.test(frase)
          ? 'calor'
          : /\b(temperatura|graus|grau)\b/.test(frase)
            ? 'temperatura'
            : 'geral';

  let dias: number[] = [];
  const marcar = (re: RegExp, valores: number[]) => {
    if (re.test(frase)) {
      if (dias.length === 0) {
        dias = valores;
      }
      frase = frase.replace(new RegExp(re.source, 'g'), ' ');
    }
  };

  const hojeDia = hoje.getDay();
  const ate = (alvo: number) => (alvo - hojeDia + 7) % 7;

  marcar(/\bdepois de amanha\b/, [2]);
  marcar(/\bamanha\b/, [1]);
  marcar(/\b(hoje|hj|agora|neste momento|agorinha)\b/, [0]);
  marcar(/\b(n?esse|n?este|no|neste)? ?(fim|final) de semana\b/, hojeDia === 0 ? [0] : [ate(6), ate(0) || 7].filter(d => d <= 6));
  DIAS_DA_SEMANA.forEach((nome, idx) => {
    marcar(new RegExp(`\\b(n?[ao]s? )?${nome}(-feira| feira)?\\b`), [ate(idx)]);
  });
  const diaExplicito = dias.length > 0;

  // Sobras que não são cidade.
  frase = frase
    .replace(/\b(de manha|pela manha|a tarde|de tarde|a noite|de noite|durante o dia|essa semana|esta semana|nessa semana|nesta semana|semana que vem|proxima semana|aqui|la fora|por aqui|kira|por favor)\b/g, ' ')
    .replace(/\s+/g, ' ');

  let cidade: string | undefined;
  const m = /\b(?:em|no|na|para|pra|de)\s+(.+)$/.exec(
    // "previsão do tempo", "como está o tempo" não têm cidade.
    frase.replace(/\b(previsao do tempo|previsao de tempo|o tempo|do tempo|a temperatura|o clima|do clima|de chuva|de sol|de frio|de calor)\b/g, ' ')
  );
  if (m) {
    const candidata = limparDestino(m[1]);
    if (candidata && !NAO_E_CIDADE.has(candidata) && !/^\d/.test(candidata)) {
      cidade = candidata;
    }
  }

  return { dias: dias.length ? dias : [0], diaExplicito, cidade, foco };
}

/** Para os parâmetros que a IA manda ("amanhã", "sábado"...). */
export function diasDoTexto(texto: string | undefined, hoje = new Date()): { dias: number[]; explicito: boolean } {
  if (!texto) {
    return { dias: [0], explicito: false };
  }
  const p = interpretarPedidoDoTempo(texto, hoje);
  return { dias: p.dias, explicito: p.diaExplicito };
}

export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

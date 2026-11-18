/**
 * Converte números escritos com algarismos para a forma falada em português do Brasil,
 * antes de mandar o texto para a voz. Ex.: "em 1500" -> "em mil e quinhentos",
 * "20°C" -> "vinte graus", "3,5%" -> "três vírgula cinco por cento",
 * "14h30" -> "catorze e trinta", "22/04/1500" -> "vinte e dois de abril de mil e quinhentos".
 *
 * Puro (sem Angular): dá para testar no Node compilando com o tsc.
 */

const UNIDADES = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = [
  '', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos',
];
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const ORDINAIS_UNIDADE = ['', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono'];
const ORDINAIS_DEZENA = [
  '', 'décimo', 'vigésimo', 'trigésimo', 'quadragésimo', 'quinquagésimo', 'sexagésimo', 'septuagésimo', 'octogésimo', 'nonagésimo',
];

/** Palavras terminadas em "a"/"as" que são masculinas ("dois dias", não "duas dias"). */
const MASCULINAS_EM_A = new Set([
  'dia', 'dias', 'mapa', 'mapas', 'problema', 'problemas', 'programa', 'programas', 'sistema', 'sistemas',
  'tema', 'temas', 'clima', 'climas', 'planeta', 'planetas', 'idioma', 'idiomas', 'poema', 'poemas',
  'telefonema', 'telefonemas', 'cinema', 'cinemas', 'drama', 'dramas', 'esquema', 'esquemas', 'mapa-mundi',
  'cometa', 'cometas', 'pijama', 'pijamas', 'sofá', 'sofás', 'guarda', 'guardas', 'e', 'a',
]);
/** Femininas que não terminam em "a". */
const FEMININAS = new Set([
  'vez', 'vezes', 'opção', 'opções', 'estação', 'estações', 'mulher', 'mulheres', 'cor', 'cores',
  'flor', 'flores', 'ponte', 'pontes', 'noite', 'noites', 'tarde', 'tardes', 'cidade', 'cidades',
  'parte', 'partes', 'lei', 'leis', 'nação', 'nações', 'geração', 'gerações', 'gente', 'árvore', 'árvores',
]);
const UNIDADES_DE_MEDIDA: Record<string, string> = {
  km: 'quilômetros',
  kg: 'quilos',
  cm: 'centímetros',
  mm: 'milímetros',
  min: 'minutos',
};
const MULTIPLICADORES = /^(mil|milhão|milhões|bilhão|bilhões|trilhão|trilhões)$/i;

function centena(n: number, feminino: boolean): string {
  if (n === 100) {
    return 'cem';
  }
  const partes: string[] = [];
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c) {
    const palavra = CENTENAS[c];
    partes.push(feminino && c >= 2 ? palavra.replace(/os$/, 'as') : palavra);
  }
  if (resto) {
    if (resto < 20) {
      partes.push(unidade(resto, feminino));
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u ? `${DEZENAS[d]} e ${unidade(u, feminino)}` : DEZENAS[d]);
    }
  }
  return partes.join(' e ');
}

function unidade(n: number, feminino: boolean): string {
  if (feminino && n === 1) return 'uma';
  if (feminino && n === 2) return 'duas';
  return UNIDADES[n];
}

/** Número inteiro por extenso (até a casa dos trilhões). */
export function inteiroPorExtenso(n: number, feminino = false): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  if (n < 0) {
    return `menos ${inteiroPorExtenso(-n, feminino)}`;
  }
  n = Math.floor(n);
  if (n < 1000) {
    return n === 0 ? 'zero' : centena(n, feminino);
  }

  const escalas: [number, string, string][] = [
    [1e12, 'trilhão', 'trilhões'],
    [1e9, 'bilhão', 'bilhões'],
    [1e6, 'milhão', 'milhões'],
  ];
  const grupos: { texto: string; valor: number }[] = [];
  let resto = n;
  for (const [base, singular, plural] of escalas) {
    const q = Math.floor(resto / base);
    if (q) {
      // "milhão" é masculino: "dois milhões de pessoas".
      grupos.push({ texto: `${centena(q, false)} ${q === 1 ? singular : plural}`, valor: q });
    }
    resto %= base;
  }
  const milhares = Math.floor(resto / 1000);
  if (milhares) {
    grupos.push({ texto: milhares === 1 ? 'mil' : `${centena(milhares, feminino)} mil`, valor: milhares });
  }
  const final = resto % 1000;
  if (final) {
    grupos.push({ texto: centena(final, feminino), valor: final });
  }

  // O "e" só entra antes do último grupo quando ele é menor que cem ou uma centena
  // redonda: "mil e quinhentos", "dois mil e vinte e seis", mas "mil oitocentos e vinte e dois".
  const ultimo = grupos[grupos.length - 1];
  const usaE = grupos.length > 1 && (ultimo.valor < 100 || ultimo.valor % 100 === 0);
  if (usaE) {
    return `${grupos.slice(0, -1).map(g => g.texto).join(' ')} e ${ultimo.texto}`;
  }
  return grupos.map(g => g.texto).join(' ');
}

function ordinal(n: number, feminino: boolean): string {
  if (n < 1 || n > 99) {
    return inteiroPorExtenso(n, feminino);
  }
  const texto = [ORDINAIS_DEZENA[Math.floor(n / 10)], ORDINAIS_UNIDADE[n % 10]].filter(Boolean).join(' ');
  return feminino ? texto.replace(/o\b/g, 'a') : texto;
}

/** "3,5" -> "três vírgula cinco"; "3,05" -> "três vírgula zero cinco". */
function decimalPorExtenso(inteiro: number, decimais: string, feminino: boolean): string {
  const zeros = /^0+/.exec(decimais)?.[0].length ?? 0;
  const restante = decimais.slice(zeros);
  const fracao = [...Array(zeros).fill('zero'), ...(restante ? [inteiroPorExtenso(Number(restante))] : [])].join(' ');
  return `${inteiroPorExtenso(inteiro, feminino)} vírgula ${fracao}`;
}

/** Palavras em "a"/"as" que não são substantivos: "em 1500 pela frota" não é feminino. */
const NAO_SUBSTANTIVOS = new Set([
  'a', 'as', 'da', 'das', 'na', 'nas', 'pela', 'pelas', 'para', 'uma', 'umas', 'essa', 'essas', 'esta', 'estas',
  'nessa', 'nessas', 'nesta', 'nestas', 'dessa', 'dessas', 'desta', 'destas', 'aquela', 'aquelas', 'sua', 'suas',
  'minha', 'minhas', 'nossa', 'nossas', 'toda', 'todas', 'cada', 'contra', 'agora', 'ainda', 'fora', 'era', 'eras',
  'outra', 'outras', 'mesma', 'mesmas', 'nenhuma', 'alguma', 'algumas', 'quando', 'onde', 'ja', 'apenas', 'mais',
]);
/** Palavras antes de um ano: "em 1500", "desde 1822" (ano é sempre masculino). */
const ANTES_DE_ANO = new Set(['em', 'de', 'desde', 'até', 'ate', 'ano', 'anos', 'década', 'decada']);

/**
 * Decide o gênero pela palavra seguinte ("duas horas", "duzentas pessoas", "dois dias").
 * Com valor 1 o substantivo vem no singular ("uma hora"); nos demais, no plural.
 */
function femininoPelaSeguinte(valor: number, antes: string, depois: string): boolean {
  const anterior = antes.split(/[^\p{L}]+/u).filter(Boolean).pop()?.toLowerCase();
  if (valor >= 1000 && valor <= 2999 && Number.isInteger(valor) && anterior && ANTES_DE_ANO.has(anterior)) {
    return false;
  }

  // O split já descarta espaços e pontuação do começo (o filter tira os vazios).
  const palavras = depois.split(/[^\p{L}-]+/u).filter(Boolean);
  let palavra = palavras[0]?.toLowerCase();
  if (palavra && MULTIPLICADORES.test(palavra)) {
    if (palavra !== 'mil') {
      return false; // "dois milhões de pessoas"
    }
    palavra = palavras[1]?.toLowerCase();
    if (palavra === 'de') {
      palavra = palavras[2]?.toLowerCase();
    }
  }
  if (!palavra || NAO_SUBSTANTIVOS.has(palavra)) {
    return false;
  }
  if (FEMININAS.has(palavra)) {
    return true;
  }
  const terminacao = valor === 1 ? /a$/ : /as$/;
  return terminacao.test(palavra) && !MASCULINAS_EM_A.has(palavra);
}

function numeroDoTexto(texto: string): { inteiro: number; decimais: string } {
  const [inteiro, decimais = ''] = texto.replace(/\./g, '').split(',');
  return { inteiro: Number(inteiro), decimais };
}

function lerNumero(texto: string, feminino: boolean): string {
  const { inteiro, decimais } = numeroDoTexto(texto);
  return decimais ? decimalPorExtenso(inteiro, decimais, feminino) : inteiroPorExtenso(inteiro, feminino);
}

function hora(h: number, m: number): string {
  if (h > 24 || m > 59) {
    return `${inteiroPorExtenso(h)} e ${inteiroPorExtenso(m)}`;
  }
  const horas = `${inteiroPorExtenso(h, true)} ${h === 1 ? 'hora' : 'horas'}`;
  return m ? `${inteiroPorExtenso(h, true)} e ${inteiroPorExtenso(m)}` : horas;
}

/** Número "solto" válido em português: 1500, 1.500, 3,5, 1.234.567,89. */
const NUMERO = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?`;

/** Troca todos os números do texto pela forma falada. */
export function numerosParaFala(texto: string): string {
  if (!/\d/.test(texto)) {
    return texto;
  }

  return (
    texto
      // Datas: 22/04/1500 e 22/04.
      .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g, (original, d, m, a) => {
        const dia = Number(d);
        const mes = Number(m);
        if (dia < 1 || dia > 31 || mes < 1 || mes > 12) {
          return original;
        }
        const diaFalado = dia === 1 ? 'primeiro' : inteiroPorExtenso(dia);
        return `${diaFalado} de ${MESES[mes - 1]}${a ? ` de ${inteiroPorExtenso(Number(a))}` : ''}`;
      })
      // Horas: 14:30, 14h30, 14h.
      .replace(/\b(\d{1,2})(?::|h)(\d{2})\b/g, (_, h, m) => hora(Number(h), Number(m)))
      .replace(/\b(\d{1,2})\s?h\b/g, (_, h) => hora(Number(h), 0))
      // Dinheiro: R$ 1.500,50.
      .replace(new RegExp(String.raw`R\$\s?(${NUMERO})`, 'g'), (_, valor) => {
        const { inteiro, decimais } = numeroDoTexto(valor);
        const reais = `${inteiroPorExtenso(inteiro)} ${inteiro === 1 ? 'real' : 'reais'}`;
        const centavos = Number(decimais.padEnd(2, '0').slice(0, 2));
        if (!centavos) {
          return reais;
        }
        const textoCentavos = `${inteiroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`;
        return inteiro ? `${reais} e ${textoCentavos}` : textoCentavos;
      })
      // Porcentagem e graus: 3,5% e 20°C / 20 °C / 20° / 20ºC ("1º" sem C é ordinal).
      .replace(new RegExp(String.raw`(${NUMERO})\s?%`, 'g'), (_, n) => `${lerNumero(n, false)} por cento`)
      .replace(new RegExp(String.raw`(-?)(${NUMERO})\s?(?:°\s?C?|º\s?C)(?![\p{L}])`, 'gu'), (_, menos, n) => {
        const valor = lerNumero(n, false);
        return `${menos ? 'menos ' : ''}${valor} ${valor === 'um' ? 'grau' : 'graus'}`;
      })
      // Ordinais: 1º, 2ª.
      .replace(/\b(\d{1,2})([ºª])/g, (_, n, marca) => ordinal(Number(n), marca === 'ª'))
      // Unidades depois de número: 80 km/h, 5 km, 2 kg, 30 min.
      .replace(/(\d)\s?km\/h\b/g, '$1 quilômetros por hora')
      .replace(/(\d)\s?(km|kg|cm|mm|min)\b/g, (_, d, u) => `${d} ${UNIDADES_DE_MEDIDA[u]}`)
      // Números longos sem separador (telefone, CPF...): dígito a dígito.
      .replace(/\b(?:0\d{6,}|\d{10,})\b/g, digitos => [...digitos].map(d => UNIDADES[Number(d)]).join(' '))
      // Negativos isolados: "-5" -> "menos cinco".
      .replace(new RegExp(String.raw`(^|[\s(])-(${NUMERO})`, 'g'), (_, antes, n) => `${antes}menos ${n}`)
      // Demais números, com o gênero da palavra seguinte.
      .replace(new RegExp(String.raw`\b(${NUMERO})\b`, 'g'), (n, _g, posicao: number, completo: string) => {
        const valor = Number(n.replace(/\./g, '').replace(',', '.'));
        const feminino = femininoPelaSeguinte(valor, completo.slice(0, posicao), completo.slice(posicao + n.length));
        return lerNumero(n, feminino);
      })
  );
}

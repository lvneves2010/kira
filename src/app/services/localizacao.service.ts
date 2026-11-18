import { Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Geolocation, PermissionStatus } from '@capacitor/geolocation';
import { AppLauncher } from '@capacitor/app-launcher';
import pkg from '../../../package.json';
import { CategoriaLugar, ModoViagem, normalizar } from './pedidos-de-local';

/**
 * Tudo o que depende de onde o usuário está, usando serviços gratuitos e sem chave:
 * - Photon (komoot), para achar um endereço ou lugar pelo nome;
 * - OSRM do FOSSGIS (routing.openstreetmap.de), para distância e tempo pelas ruas;
 * - Overpass (OpenStreetMap), para o lugar mais próximo de uma categoria;
 * - Google Maps, aberto por link, para mostrar o caminho.
 *
 * Os servidores públicos do OpenStreetMap são de uso justo: poucas consultas por
 * usuário estão dentro da regra; volume alto exige servidor próprio ou pago.
 */

export interface Coordenadas {
  lat: number;
  lon: number;
}

export interface Lugar extends Coordenadas {
  /** Nome para falar: "Avenida Paulista, em São Paulo". */
  descricao: string;
  nome: string;
}

export interface Trajeto {
  metros: number;
  segundos: number;
}

export interface LugarProximo extends Coordenadas {
  nome: string | null;
  metros: number;
}

const USER_AGENT = `KIRA/${pkg.version} (assistente de voz Android)`;
const TEMPO_LIMITE_MS = 8000;

const PALAVRAS_DE_RUA = /^(rua|r|avenida|av|alameda|travessa|praca|estrada|rodovia|viaduto|largo|ladeira|marginal)\b/;

@Injectable({ providedIn: 'root' })
export class LocalizacaoService {
  /** Posição recente, para não acionar o GPS de novo em perguntas seguidas. */
  private ultimaPosicao?: { coords: Coordenadas; quando: number; precisa: boolean };

  async obterPosicao(precisa = false): Promise<Coordenadas> {
    const recente = this.ultimaPosicao;
    if (recente && Date.now() - recente.quando < 60000 && (recente.precisa || !precisa)) {
      return recente.coords;
    }

    await this.garantirPermissao();

    const tentar = async (alta: boolean, timeout: number) => {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: alta, timeout, maximumAge: 60000 });
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    };

    try {
      let coords: Coordenadas;
      try {
        coords = await tentar(precisa, precisa ? 10000 : 15000);
      } catch (err) {
        if (!precisa) {
          throw err;
        }
        // Dentro de casa o GPS pode demorar: a localização pela rede já serve.
        console.warn('diagnostic: localização precisa falhou, tentando a aproximada ->', err);
        coords = await tentar(false, 15000);
      }
      this.ultimaPosicao = { coords, quando: Date.now(), precisa };
      return coords;
    } catch (err) {
      console.error('diagnostic: getCurrentPosition failed ->', err);
      throw new Error(
        'Não consegui obter sua localização. Verifique se a localização está ativada no aparelho e tente novamente.'
      );
    }
  }

  private async garantirPermissao(): Promise<void> {
    let status: PermissionStatus;

    try {
      status = await Geolocation.checkPermissions();
    } catch (err) {
      console.error('diagnostic: checkPermissions failed ->', err);
      // No navegador (npm start) o plugin não verifica: o próprio navegador pergunta.
      if (!Capacitor.isNativePlatform()) {
        return;
      }
      throw new Error('Não foi possível verificar a permissão de localização neste aparelho.');
    }

    if (status.location === 'granted' || status.coarseLocation === 'granted') {
      return;
    }

    try {
      status = await Geolocation.requestPermissions();
    } catch (err) {
      console.error('diagnostic: requestPermissions failed ->', err);
      throw new Error('Não foi possível solicitar a permissão de localização.');
    }

    if (status.location !== 'granted' && status.coarseLocation !== 'granted') {
      throw new Error(
        'Preciso da sua localização para responder. Ative em Ajustes do aparelho, Apps, K.I.R.A., Permissões, Localização.'
      );
    }
  }

  /**
   * Acha um lugar pelo nome. Faz duas buscas: uma perto do usuário (para "avenida
   * paulista", "shopping ibirapuera") e outra sem viés (para cidades: "porto alegre"
   * perto de São Paulo devolveria a "Rua Porto Alegre").
   */
  async geocodificar(nome: string, perto?: Coordenadas): Promise<Lugar | null> {
    const base = `https://photon.komoot.io/api/?q=${encodeURIComponent(nome)}&limit=5`;
    const [comVies, semVies] = await Promise.all([
      perto ? this.buscarPhoton(`${base}&lat=${perto.lat}&lon=${perto.lon}`) : Promise.resolve([]),
      this.buscarPhoton(base),
    ]);

    const alvo = normalizar(nome);
    const mesmoNome = (f: FeaturePhoton) => normalizar(f.properties.name ?? '') === alvo;
    const pertoDoUsuario = (f: FeaturePhoton) =>
      !!perto && distanciaEmMetros(perto, coordsDe(f)) < 80000;
    // Entre homônimos, a cidade vem antes do estado ("São Paulo").
    const cidadesPrimeiro = [...semVies].sort((a, b) => Number(ehCidade(b)) - Number(ehCidade(a)));

    const escolhido =
      comVies.find(f => mesmoNome(f) && pertoDoUsuario(f)) ??
      (PALAVRAS_DE_RUA.test(alvo) ? comVies.find(pertoDoUsuario) : undefined) ??
      cidadesPrimeiro.find(f => mesmoNome(f) && f.properties.countrycode === 'BR') ??
      cidadesPrimeiro.find(mesmoNome) ??
      comVies[0] ??
      semVies[0];

    if (escolhido) {
      return { ...coordsDe(escolhido), nome: escolhido.properties.name ?? nome, descricao: descreverLugar(escolhido) };
    }

    // Photon fora do ar ou sem resultado. Primeiro uma cidade com esse nome exato (o Nominatim,
    // com a preferência pela região do usuário, trocaria "Curitiba" por uma rua homônima), depois
    // o Nominatim para endereços e lugares, e por último qualquer cidade parecida.
    return (
      (await this.geocodificarCidade(nome, true)) ??
      (await this.geocodificarNominatim(nome, perto)) ??
      (await this.geocodificarCidade(nome, false))
    );
  }

  private async geocodificarNominatim(nome: string, perto?: Coordenadas): Promise<Lugar | null> {
    // Caixa de ~50 km ao redor do usuário só como preferência (sem "bounded"): cidades distantes continuam valendo.
    const caixa = perto ? `&viewbox=${perto.lon - 0.5},${perto.lat + 0.5},${perto.lon + 0.5},${perto.lat - 0.5}` : '';
    try {
      await this.aguardarVezNominatim();
      const dados = await this.getJson<ResultadoNominatim[]>(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(nome)}&format=jsonv2&limit=1` +
          `&addressdetails=1&accept-language=pt-BR${caixa}`
      );
      const r = dados[0];
      if (!r) {
        return null;
      }
      const a = r.address ?? {};
      const cidade = a.city ?? a.town ?? a.village ?? a.municipality;
      const titulo = r.name || nome;
      const regiao = a.country_code === 'br' ? a.state : a.country;
      const descricao =
        cidade && cidade !== titulo ? `${titulo}, em ${cidade}` : regiao && regiao !== titulo ? `${titulo}, ${regiao}` : titulo;
      return { lat: Number(r.lat), lon: Number(r.lon), nome: titulo, descricao };
    } catch (err) {
      console.warn('diagnostic: Nominatim falhou ->', err);
      return null;
    }
  }

  private async geocodificarCidade(nome: string, soNomeExato: boolean): Promise<Lugar | null> {
    try {
      const dados = await this.getJson<{ results?: CidadeOpenMeteo[] }>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nome)}&count=5&language=pt&format=json`
      );
      const alvo = normalizar(nome);
      const resultados = (dados.results ?? []).filter(r => !soNomeExato || normalizar(r.name) === alvo);
      const c = resultados.find(r => r.country_code === 'BR') ?? resultados[0];
      if (!c) {
        return null;
      }
      const regiao = c.country_code === 'BR' ? c.admin1 : c.country;
      return {
        lat: c.latitude,
        lon: c.longitude,
        nome: c.name,
        descricao: regiao && regiao !== c.name ? `${c.name}, ${regiao}` : c.name,
      };
    } catch (err) {
      console.warn('diagnostic: geocodificação do Open-Meteo falhou ->', err);
      return null;
    }
  }

  private async buscarPhoton(url: string): Promise<FeaturePhoton[]> {
    // O servidor público às vezes responde 503 em picos: uma nova tentativa costuma bastar.
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        const dados = await this.getJson<{ features?: FeaturePhoton[] }>(url, 5000);
        return (dados.features ?? []).filter(f => f.geometry?.coordinates?.length === 2);
      } catch (err) {
        console.warn(`diagnostic: Photon falhou (tentativa ${tentativa}) ->`, err);
        // Sem resposta (fora do ar): não vale esperar de novo, vai direto para a reserva.
        if (!(err instanceof Error && err.message.startsWith('HTTP'))) {
          break;
        }
        await new Promise(r => setTimeout(r, 700));
      }
    }
    return [];
  }

  /** Distância e tempo pelas ruas. Sem trânsito: o OSRM usa a velocidade das vias. */
  async calcularTrajeto(origem: Coordenadas, destino: Coordenadas, modo: ModoViagem): Promise<Trajeto> {
    const perfil = modo === 'a_pe' ? 'routed-foot' : modo === 'bicicleta' ? 'routed-bike' : 'routed-car';
    const url =
      `https://routing.openstreetmap.de/${perfil}/route/v1/driving/` +
      `${origem.lon},${origem.lat};${destino.lon},${destino.lat}?overview=false`;

    const dados = await this.getJson<{ code: string; routes?: { distance: number; duration: number }[] }>(url);
    const rota = dados.routes?.[0];
    if (dados.code !== 'Ok' || !rota) {
      throw new Error(`OSRM sem rota: ${dados.code}`);
    }
    return { metros: rota.distance, segundos: rota.duration };
  }

  /**
   * O lugar mais próximo de uma categoria, pelo OpenStreetMap. Null se não houver nada perto.
   * Usa o Nominatim (rápido e estável) e, se ele falhar, o Overpass.
   */
  async lugarMaisProximo(categoria: CategoriaLugar, perto: Coordenadas): Promise<LugarProximo | null> {
    try {
      return await this.lugarMaisProximoNominatim(categoria, perto);
    } catch (err) {
      console.warn('diagnostic: Nominatim (lugar próximo) falhou, tentando Overpass ->', err);
      return this.lugarMaisProximoOverpass(categoria, perto);
    }
  }

  private async lugarMaisProximoNominatim(categoria: CategoriaLugar, perto: Coordenadas): Promise<LugarProximo | null> {
    // '["amenity"="pharmacy"]' → '[amenity=pharmacy]', a sintaxe de categoria do Nominatim.
    const termos = categoria.filtros.map(f => f.replace(/"/g, ''));
    // Caixas de ~900 m, ~3 km e ~10 km ao redor do usuário: a busca devolve no máximo 40
    // resultados, e não em ordem de distância, então começar pequeno garante o mais próximo.
    for (const meiaCaixa of [0.008, 0.03, 0.09]) {
      const lugares: LugarProximo[] = [];
      for (const termo of termos) {
        await this.aguardarVezNominatim();
        const caixa = `${perto.lon - meiaCaixa},${perto.lat + meiaCaixa},${perto.lon + meiaCaixa},${perto.lat - meiaCaixa}`;
        const dados = await this.getJson<ResultadoNominatim[]>(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(termo)}&format=jsonv2&limit=40` +
            `&bounded=1&viewbox=${caixa}&accept-language=pt-BR`
        );
        for (const r of dados) {
          const coords = { lat: Number(r.lat), lon: Number(r.lon) };
          lugares.push({ ...coords, nome: r.name || null, metros: distanciaEmMetros(perto, coords) });
        }
      }
      const escolhido = escolherMaisProximo(lugares);
      if (escolhido) {
        return escolhido;
      }
    }
    return null;
  }

  private proximaConsultaNominatim = 0;

  /** Regra de uso do Nominatim: no máximo uma consulta por segundo (vale também para chamadas em paralelo). */
  private async aguardarVezNominatim(): Promise<void> {
    const agora = Date.now();
    const vez = Math.max(agora, this.proximaConsultaNominatim);
    this.proximaConsultaNominatim = vez + 1000;
    if (vez > agora) {
      await new Promise(r => setTimeout(r, vez - agora));
    }
  }

  private async lugarMaisProximoOverpass(categoria: CategoriaLugar, perto: Coordenadas): Promise<LugarProximo | null> {
    // Primeiro um raio curto (resposta pequena e rápida); se não achar, amplia.
    for (const raio of [1500, 8000]) {
      const consultas = categoria.filtros.map(f => `nwr${f}(around:${raio},${perto.lat},${perto.lon});`).join('');
      const query = `[out:json][timeout:10];(${consultas});out center 300;`;
      const dados = await this.consultarOverpass(query);

      const lugares = (dados.elements ?? [])
        .map(e => {
          const lat = e.lat ?? e.center?.lat;
          const lon = e.lon ?? e.center?.lon;
          if (lat === undefined || lon === undefined) {
            return null;
          }
          const nome = e.tags?.name ?? e.tags?.brand ?? e.tags?.operator ?? null;
          return { lat, lon, nome, metros: distanciaEmMetros(perto, { lat, lon }) };
        })
        .filter((l): l is LugarProximo => l !== null);

      const escolhido = escolherMaisProximo(lugares);
      if (escolhido) {
        return escolhido;
      }
    }
    return null;
  }

  /** Overpass principal e, se falhar (fila cheia, fora do ar), um espelho. */
  private async consultarOverpass(query: string): Promise<{ elements?: ElementoOverpass[] }> {
    const servidores = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    let ultimoErro: unknown;
    for (const servidor of servidores) {
      try {
        return await this.getJson(`${servidor}?data=${encodeURIComponent(query)}`, 9000);
      } catch (err) {
        console.warn('diagnostic: Overpass falhou ->', servidor, err);
        ultimoErro = err;
      }
    }
    throw ultimoErro;
  }

  /** Abre o Google Maps com o caminho até o destino (coordenadas ou texto). */
  async abrirRota(destino: Coordenadas | string, modo: ModoViagem = 'carro'): Promise<void> {
    const travelmode = { carro: 'driving', a_pe: 'walking', bicicleta: 'bicycling', transporte: 'transit' }[modo];
    const alvo = typeof destino === 'string' ? destino : `${destino.lat},${destino.lon}`;
    await this.abrirUrl(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(alvo)}&travelmode=${travelmode}`
    );
  }

  /** Abre o Google Maps buscando um tipo de lugar perto do usuário ("farmácia"). */
  async abrirBusca(termo: string): Promise<void> {
    await this.abrirUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(termo)}`);
  }

  private async abrirUrl(url: string): Promise<void> {
    console.log('diagnostic: abrindo mapa ->', url);
    if (Capacitor.isNativePlatform()) {
      // Com o Google Maps instalado, o Android abre o app; senão, o navegador.
      await AppLauncher.openUrl({ url });
    } else {
      window.open(url, '_blank');
    }
  }

  private async getJson<T>(url: string, tempoLimiteMs = TEMPO_LIMITE_MS): Promise<T> {
    if (Capacitor.isNativePlatform()) {
      // Chamada nativa: não depende de CORS e permite identificar o app (pedido dos servidores do OSM).
      const resposta = await CapacitorHttp.get({
        url,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        connectTimeout: tempoLimiteMs,
        readTimeout: tempoLimiteMs,
        responseType: 'json',
      });
      if (resposta.status < 200 || resposta.status >= 300) {
        throw new Error(`HTTP ${resposta.status} em ${url}`);
      }
      return (typeof resposta.data === 'string' ? JSON.parse(resposta.data) : resposta.data) as T;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tempoLimiteMs);
    try {
      const resposta = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status} em ${url}`);
      }
      return (await resposta.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface FeaturePhoton {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    osm_key?: string;
    type?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
  };
}

interface ElementoOverpass {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: { name?: string; brand?: string; operator?: string };
}

interface ResultadoNominatim {
  lat: string;
  lon: string;
  name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
    country_code?: string;
  };
}

interface CidadeOpenMeteo {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  country?: string;
  admin1?: string;
}

function ehCidade(f: FeaturePhoton): boolean {
  return f.properties.osm_key === 'place' && ['city', 'town', 'village', 'municipality'].includes(f.properties.type ?? '');
}

/** O mais próximo; se houver um com nome quase à mesma distância, prefere esse. */
function escolherMaisProximo(lugares: LugarProximo[]): LugarProximo | null {
  if (lugares.length === 0) {
    return null;
  }
  const ordenados = [...lugares].sort((a, b) => a.metros - b.metros);
  return ordenados.find(l => l.nome && l.metros - ordenados[0].metros < 150) ?? ordenados[0];
}

function coordsDe(f: FeaturePhoton): Coordenadas {
  return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
}

/** "Avenida Paulista, em São Paulo"; "Porto Alegre, Rio Grande do Sul"; "Lisboa, Portugal". */
function descreverLugar(f: FeaturePhoton): string {
  const p = f.properties;
  const nome = p.name ?? '';
  if (ehCidade(f)) {
    const regiao = p.countrycode === 'BR' ? p.state : p.country;
    return regiao && regiao !== nome ? `${nome}, ${regiao}` : nome;
  }
  if (p.city && p.city !== nome) {
    return `${nome}, em ${p.city}`;
  }
  if (p.state && p.state !== nome && p.countrycode === 'BR') {
    return `${nome}, ${p.state}`;
  }
  return p.countrycode && p.countrycode !== 'BR' && p.country ? `${nome}, ${p.country}` : nome;
}

/** Distância em linha reta (fórmula de haversine). */
export function distanciaEmMetros(a: Coordenadas, b: Coordenadas): number {
  const raio = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * raio * Math.asin(Math.sqrt(h));
}

/** "350 metros", "2,5 quilômetros", "1132 quilômetros". */
export function falarDistancia(metros: number): string {
  if (metros < 1000) {
    const m = Math.max(10, Math.round(metros / (metros < 200 ? 10 : 50)) * (metros < 200 ? 10 : 50));
    return `${m} metros`;
  }
  const km = metros / 1000;
  if (km < 10) {
    const arredondado = Math.round(km * 10) / 10;
    if (arredondado === 1) {
      return 'um quilômetro';
    }
    return `${String(arredondado).replace('.', ',')} quilômetros`;
  }
  return `${Math.round(km)} quilômetros`;
}

const HORAS_FEMININAS: Record<number, string> = { 1: 'uma', 2: 'duas', 21: 'vinte e uma', 22: 'vinte e duas' };

/** "um minuto", "25 minutos", "uma hora e 20 minutos", "14 horas e 45 minutos". */
export function falarDuracao(segundos: number): string {
  const totalMin = Math.round(segundos / 60);
  if (totalMin < 1) {
    return 'menos de um minuto';
  }
  if (totalMin < 60) {
    return totalMin === 1 ? 'um minuto' : `${totalMin} minutos`;
  }
  // Viagens longas: arredonda para 5 minutos, a precisão real não é maior que isso.
  const arredondado = Math.round(totalMin / 5) * 5;
  const h = Math.floor(arredondado / 60);
  const m = arredondado % 60;
  const horas = `${HORAS_FEMININAS[h] ?? h} ${h === 1 ? 'hora' : 'horas'}`;
  return m === 0 ? horas : `${horas} e ${m} minutos`;
}

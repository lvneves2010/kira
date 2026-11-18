import { Component, NgZone, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonAlert,
  IonMenuButton,
  IonButtons,
  IonFooter,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { mic, save } from 'ionicons/icons';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { Torch } from '@capawesome/capacitor-torch';
import { environment } from '../../environments/environment';
import { BrandHeaderComponent } from './components/brand-header/brand-header.component';
import { StatusPanelComponent } from './components/status-panel/status-panel.component';
import { SaveBannerComponent } from './components/save-banner/save-banner.component';
import { VoiceActionComponent } from './components/voice-action/voice-action.component';
import { SettingsMenuComponent } from './components/settings-menu/settings-menu.component';
import { VoiceCommandsService, VoiceCommandMatch, AsyncCommandKind } from '../services/voice-commands.service';
import { WeatherService } from '../services/weather.service';
import {
  Coordenadas,
  LocalizacaoService,
  distanciaEmMetros,
  falarDistancia,
  falarDuracao,
} from '../services/localizacao.service';
import {
  ModoViagem,
  PedidoLocal,
  PedidoTempo,
  diasDoTexto,
  encontrarCategoria,
  interpretarPedidoDeLocal,
  interpretarPedidoDoTempo,
  normalizar,
} from '../services/pedidos-de-local';
import { AnunciosService } from '../services/anuncios.service';
import { VozService } from '../services/voz.service';
import { RodapeEmpresaComponent } from '../compartilhado/rodape-empresa/rodape-empresa.component';

/** O que a IA devolve: um texto para falar ou uma ação do app para executar. */
type AcaoIA = AsyncCommandKind | 'salvar' | PedidoLocal;
type RespostaIA = { tipo: 'texto'; texto: string } | { tipo: 'acao'; acao: AcaoIA };

const MODO_FALADO: Record<ModoViagem, string> = {
  carro: 'de carro',
  a_pe: 'a pé',
  bicicleta: 'de bicicleta',
  transporte: 'de carro',
};

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonAlert,
    IonMenuButton,
    IonButtons,
    IonFooter,
    BrandHeaderComponent,
    StatusPanelComponent,
    SaveBannerComponent,
    VoiceActionComponent,
    SettingsMenuComponent,
    RodapeEmpresaComponent,
  ],
})
export class HomePage {
  readonly anuncios = inject(AnunciosService);

  isProcessing = false;
  recognizedNote: string | null = null;
  recognizedCommand: string | null = null;
  commandResponse: string | null = null;
  statusText = 'Pronto. Toque para falar com a Kira.';
  hasMicrophoneAccess = false;
  micTestStatus = '';
  isSpeaking = false;
  awaitingSaveCommand = false;
  isListeningForSave = false;

  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private stream?: MediaStream;
  errorAlertOpen = false;
  errorMessage = '';
  isListeningForCommand = false;
  private speechRecognition?: any;
  private followUpRecognition?: any;
  private speechAborted = false;
  private saveListenActive = false;
  private readonly saveListenWindowMs = 10000;
  lastResponseText: string | null = null;

  // Memória curta da conversa com a IA: permite perguntas de seguimento
  // ("e amanhã?", "explica melhor") sem pesar a requisição.
  private llmHistory: { role: 'user' | 'model'; text: string }[] = [];
  private llmLastInteraction = 0;
  private static readonly LLM_HISTORY_MAX_TURNS = 4; // pares pergunta/resposta
  private static readonly LLM_HISTORY_TTL_MS = 5 * 60 * 1000; // esquece após 5 min parado

  private readonly ngZone = inject(NgZone);
  private readonly voiceCommands = inject(VoiceCommandsService);
  private readonly weatherService = inject(WeatherService);
  private readonly localizacao = inject(LocalizacaoService);

  /** Último destino calculado, para "abre o mapa" logo depois de "quanto tempo até X". */
  private ultimoDestino?: { coords: Coordenadas; modo: ModoViagem };
  private readonly voz = inject(VozService);

  constructor() {
    addIcons({ mic, save });
  }

  /** Banner do AdMob só nas telas internas (nunca na abertura). */
  ionViewDidEnter() {
    this.anuncios.mostrarBanner();
    // Já deixa a lista de vozes pronta para a primeira fala não atrasar.
    void this.voz.carregar();
    if (this.voz.modo$.value === 'natural') {
      void this.voz.prepararNatural();
    }
  }

  async recognizeNote() {
    if (this.isProcessing) {
      return;
    }

    this.recognizedNote = null;
    this.micTestStatus = 'Verificando acesso ao microfone...';
    this.isProcessing = true;
    this.hasMicrophoneAccess = false;

    try {
      console.log('diagnostic: navigator.mediaDevices present=', !!navigator.mediaDevices);
      await this.requestMicrophonePermission();
      await this.initAudio();
      this.hasMicrophoneAccess = true;
      this.micTestStatus = 'Microfone autorizado. Ouvindo som... fale ou faça barulho.';

      const detected = await this.listenForSound(3000);
      if (detected) {
        this.micTestStatus = 'Som detectado! O microfone está funcionando.';
      } else {
        this.micTestStatus = 'Nenhum som detectado. Fale ou faça barulho mais alto e tente novamente.';
      }
    } catch (error) {
      const e: any = error;
      let errInfo = '';
      try {
        if (e && (e.name || e.message)) {
          errInfo = `${e.name || ''}: ${e.message || ''}`.trim();
        } else {
          errInfo = JSON.stringify(e);
        }
      } catch (jsonErr) {
        errInfo = String(e);
      }
      if (e && e.stack) {
        errInfo += '\n\nStack:\n' + e.stack;
      }

      this.micTestStatus = `Erro: ${errInfo.split('\n')[0]}`;
      this.errorMessage = `Detalhes:\n${errInfo}\n\nVerifique permissões do app nas Configurações.`;
      this.errorAlertOpen = true;
      console.error('diagnostic: recognizeNote error ->', e);
    } finally {
      this.stopAudio();
      this.isProcessing = false;
    }
  }

  async startCommandRecognition() {
    if (this.isListeningForCommand || this.isSpeaking) {
      return;
    }

    this.stopFollowUpListening();
    this.awaitingSaveCommand = false;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.errorMessage = 'Reconhecimento de voz não suportado neste WebView.';
      this.errorAlertOpen = true;
      return;
    }

    this.speechRecognition = new SpeechRecognition();
    this.speechRecognition.lang = 'pt-BR';
    this.speechRecognition.interimResults = false;
    this.speechRecognition.maxAlternatives = 1;

    this.isListeningForCommand = true;
    this.statusText = 'Escutando... fale agora.';

    this.speechRecognition.onresult = async (event: any) => {
      const transcript = (event.results[0][0].transcript || '').toLowerCase().trim();
      console.log('diagnostic: speech transcript=', transcript);
      const normalized = this.normalizeTranscript(transcript);
      console.log('diagnostic: normalized transcript=', normalized);
      await this.processRecognizedCommand(normalized);
    };

    this.speechRecognition.onerror = (ev: any) => {
      console.warn('diagnostic: speech error', ev);
      const erro = ev.error || ev.message || String(ev);
      this.ngZone.run(() => {
        // Silêncio ou fala não reconhecida é normal: só avisa no status, sem alerta.
        if (erro === 'no-speech' || erro === 'no-match' || erro === 'aborted') {
          this.statusText = 'Não ouvi nada. Toque e fale de novo.';
          return;
        }
        this.errorMessage =
          erro === 'not-allowed' || erro === 'service-not-allowed'
            ? 'A Kira precisa de permissão para usar o microfone. Ative em Ajustes > Apps > K.I.R.A. > Permissões.'
            : erro === 'network'
              ? 'O reconhecimento de voz precisa de internet. Verifique a conexão e tente de novo.'
              : `Reconhecimento de voz falhou: ${erro}`;
        this.errorAlertOpen = true;
      });
    };

    this.speechRecognition.onend = () => {
      this.ngZone.run(() => {
        this.isListeningForCommand = false;
        if (!this.isSpeaking && !this.awaitingSaveCommand && this.statusText === 'Escutando... fale agora.') {
          this.statusText = 'Pronto. Toque para falar com a Kira.';
        }
      });
    };

    try {
      this.speechRecognition.start();
    } catch (startErr) {
      console.error('diagnostic: speech start failed ->', startErr);
      this.ngZone.run(() => {
        this.errorMessage = `Não foi possível iniciar reconhecimento de voz: ${startErr}`;
        this.errorAlertOpen = true;
        this.isListeningForCommand = false;
        this.statusText = 'Pronto. Toque para falar com a Kira.';
      });
    }
  }

  async stopSpeaking() {
    this.speechAborted = true;
    this.stopFollowUpListening();

    try {
      await this.voz.parar();
    } catch (err) {
      console.warn('diagnostic: parar a fala falhou', err);
    }

    this.ngZone.run(() => {
      this.isSpeaking = false;
      this.awaitingSaveCommand = false;
      this.statusText = this.lastResponseText
        ? 'Leitura interrompida. Toque no ícone de salvar ou fale um novo comando.'
        : 'Pronto. Toque para falar com a Kira.';
    });
  }

  private async processRecognizedCommand(normalized: string): Promise<void> {
    try {
      if (this.lastResponseText && this.isSaveCommand(normalized)) {
        this.stopFollowUpListening();
        await this.saveResponseToFile();
        return;
      }

      const kiraRemainder = this.matchKiraTrigger(normalized);

      // Só "Kira": responde como alguém que foi chamado e fica ouvindo.
      if (kiraRemainder === '') {
        const resposta = this.sortear(['Oi! Pode falar, estou ouvindo.', 'Estou aqui, pode falar comigo.', 'Oi! Em que posso te ajudar?', 'Sim? Pode falar, estou ouvindo.']);
        this.ngZone.run(() => {
          this.recognizedCommand = normalized;
          this.commandResponse = resposta;
          this.statusText = 'Ouvindo...';
        });
        await this.speakResponse(resposta);
        return;
      }

      // "Kira" no começo é opcional: tenta primeiro um comando conhecido
      // (ex.: "Kira, feche o aplicativo") e, se nada casar, a frase vai para a IA.
      const frase = kiraRemainder ?? normalized;

      // Perguntas que dependem de onde o usuário está (distância, rota, lugar próximo).
      const pedidoLocal = interpretarPedidoDeLocal(frase);
      if (pedidoLocal) {
        await this.handlePedidoLocal(normalized, pedidoLocal);
        return;
      }

      const commandResult = this.voiceCommands.match(frase);
      await this.executeCommandResult(normalized, commandResult, frase);
    } catch (e) {
      console.error('diagnostic: processRecognizedCommand error ->', e);
      this.ngZone.run(() => {
        this.errorMessage = 'Erro ao processar resultado de voz.';
        this.errorAlertOpen = true;
        this.resetAwaitingSave();
      });
    }
  }

  /**
   * Manda a pergunta para a IA. Se falhar, fala a `reserva` (resposta fixa do comando)
   * ou uma mensagem amigável, em vez de só mostrar um alerta mudo.
   */
  private async handleLlmQuestion(normalized: string, question: string, reserva?: string): Promise<void> {
    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = 'Pensando...';
      this.statusText = 'Pensando...';
    });

    let resposta: string;
    try {
      const resultado = await this.queryLLM(question);
      if (resultado.tipo === 'acao') {
        await this.executarAcaoDaIA(normalized, resultado.acao);
        return;
      }
      resposta = this.sanitizeForSpeech(resultado.texto).trim();
      this.ngZone.run(() => (this.statusText = 'Resposta recebida'));
    } catch (llmError) {
      console.error('diagnostic: queryLLM failed ->', llmError);
      resposta =
        reserva ||
        (navigator.onLine === false
          ? 'Parece que o celular está sem internet. Assim que voltar a conexão, me pergunte de novo.'
          : 'Não consegui pensar numa resposta agora. Pode tentar de novo daqui a pouquinho?');
      this.ngZone.run(() => (this.statusText = 'Não consegui consultar a IA'));
    }

    this.ngZone.run(() => (this.commandResponse = resposta));
    await this.speakResponse(resposta);
  }

  private async executarAcaoDaIA(normalized: string, acao: AcaoIA): Promise<void> {
    if (typeof acao === 'object') {
      await this.handlePedidoLocal(normalized, acao);
      return;
    }
    if (acao === 'salvar') {
      if (this.lastResponseText) {
        await this.saveResponseToFile();
      } else {
        await this.speakResponse('Ainda não tenho nenhuma resposta para salvar.');
      }
      return;
    }
    await this.executeCommandResult(normalized, {
      response: '',
      speak: true,
      requiresAsyncHandling: acao,
      matched: true,
    });
  }

  private async handleRepeatRequest(normalized: string): Promise<void> {
    const texto = this.lastResponseText || 'Ainda não falei nada para repetir. Pode me perguntar alguma coisa!';
    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = texto;
      this.statusText = 'Repetindo';
    });
    await this.speakResponse(texto);
  }

  private sortear(opcoes: string[]): string {
    return opcoes[Math.floor(Math.random() * opcoes.length)];
  }

  private async executeCommandResult(
    normalized: string,
    commandResult: VoiceCommandMatch,
    frase: string = normalized
  ): Promise<void> {
    // Nenhum comando conhecido: em vez de "não entendi", a IA tenta responder.
    if (!commandResult.matched) {
      await this.handleLlmQuestion(normalized, frase);
      return;
    }

    if (commandResult.requiresAsyncHandling === 'weather') {
      await this.handleWeatherRequest(normalized, interpretarPedidoDoTempo(frase));
      return;
    }

    if (commandResult.requiresAsyncHandling === 'llm') {
      await this.handleLlmQuestion(normalized, frase, commandResult.response);
      return;
    }

    if (commandResult.requiresAsyncHandling === 'repeat') {
      await this.handleRepeatRequest(normalized);
      return;
    }

    if (commandResult.requiresAsyncHandling === 'exitApp') {
      await this.handleExitAppRequest(normalized);
      return;
    }

    if (commandResult.requiresAsyncHandling === 'torchOn' || commandResult.requiresAsyncHandling === 'torchOff') {
      await this.handleTorchRequest(normalized, commandResult.requiresAsyncHandling === 'torchOn');
      return;
    }

    const responseText = this.sanitizeForSpeech(commandResult.response).trim();
    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = responseText;
      this.statusText = commandResult.speak ? 'Comando reconhecido' : 'Comando não reconhecido';
    });

    if (commandResult.speak) {
      console.log('diagnostic: command recognized, calling native TTS speak()');
      await this.speakResponse(responseText);
    } else {
      console.log('diagnostic: command not spoken, response=', responseText);
      this.ngZone.run(() => this.resetAwaitingSave());
    }
  }

  private resetAwaitingSave(): void {
    this.awaitingSaveCommand = false;
    this.isListeningForSave = false;
  }

  private async handleWeatherRequest(normalized: string, pedido?: PedidoTempo): Promise<void> {
    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = 'Consultando a previsão do tempo...';
      this.statusText = 'Consultando previsão...';
    });

    try {
      const summary = await this.weatherService.responder(pedido);
      const cleanSummary = this.sanitizeForSpeech(summary).trim();
      this.ngZone.run(() => {
        this.commandResponse = cleanSummary;
        this.statusText = 'Previsão recebida';
      });
      await this.speakResponse(cleanSummary);
    } catch (weatherError) {
      console.error('diagnostic: handleWeatherRequest failed ->', weatherError);
      const message =
        weatherError instanceof Error
          ? weatherError.message
          : 'Não foi possível obter a previsão do tempo agora.';
      this.ngZone.run(() => {
        this.commandResponse = message;
        this.errorMessage = message;
        this.errorAlertOpen = true;
        this.statusText = 'Erro na previsão';
        this.resetAwaitingSave();
      });
    }
  }

  private async handlePedidoLocal(normalized: string, pedido: PedidoLocal): Promise<void> {
    console.log('diagnostic: pedido de local ->', JSON.stringify(pedido, (k, v) => (k === 'categoria' && v ? v.nome : v)));
    switch (pedido.tipo) {
      case 'tempo':
        return this.handleWeatherRequest(normalized, pedido.pedido);
      case 'distancia':
        return this.handleDistancia(normalized, pedido.destino, pedido.origem, pedido.foco, pedido.modo);
      case 'rota':
        return this.falarEAbrirMapa(normalized, `Abrindo o caminho até ${pedido.destino} no Google Maps.`, () =>
          this.localizacao.abrirRota(pedido.destino, pedido.modo)
        );
      case 'proximo':
        return this.handleLugarProximo(normalized, pedido);
      case 'abrirMapa': {
        const destino = this.ultimoDestino;
        if (!destino) {
          this.mostrarResposta(normalized, 'Comando reconhecido');
          await this.speakResponse(
            'Ainda não tenho um destino para mostrar. Você pode dizer, por exemplo: como chego na avenida paulista?'
          );
          return;
        }
        return this.falarEAbrirMapa(normalized, 'Abrindo o caminho no Google Maps.', () =>
          this.localizacao.abrirRota(destino.coords, destino.modo)
        );
      }
    }
  }

  /** "Quanto tempo daqui até a avenida paulista?", "qual a distância de São Paulo até Porto Alegre?" */
  private async handleDistancia(
    normalized: string,
    nomeDestino: string,
    nomeOrigem: string | undefined,
    foco: 'tempo' | 'distancia',
    modo: ModoViagem
  ): Promise<void> {
    this.mostrarResposta(normalized, 'Calculando o caminho...', 'Calculando...');

    let texto: string;
    try {
      // Com origem citada, a posição só ajuda a escolher entre lugares de mesmo nome.
      const aqui = nomeOrigem
        ? await this.localizacao.obterPosicao().catch(() => undefined)
        : await this.localizacao.obterPosicao();
      const [origem, destino] = await Promise.all([
        nomeOrigem ? this.localizacao.geocodificar(nomeOrigem, aqui) : Promise.resolve(null),
        this.localizacao.geocodificar(nomeDestino, aqui),
      ]);

      if (nomeOrigem && !origem) {
        texto = `Não encontrei ${nomeOrigem} no mapa. Pode falar o nome de outro jeito, com a cidade?`;
      } else if (!destino) {
        texto = `Não encontrei ${nomeDestino} no mapa. Pode falar o nome de outro jeito, com a cidade?`;
      } else {
        const partida = (origem ?? aqui) as Coordenadas;
        const trecho = origem ? `de ${origem.descricao} até ${destino.descricao}` : `daqui até ${destino.descricao}`;
        texto = await this.descreverTrajeto(partida, destino, trecho, foco, modo, !origem);
        this.ultimoDestino = { coords: destino, modo };
        texto += ' Se quiser ver o caminho, diga: abre o mapa.';
      }
    } catch (err) {
      console.error('diagnostic: handleDistancia failed ->', err);
      texto =
        err instanceof Error && err.message.includes('localização')
          ? err.message
          : 'Não consegui calcular esse caminho agora. Verifique a internet e tente de novo.';
    }

    this.ngZone.run(() => {
      this.commandResponse = texto;
      this.statusText = 'Resposta pronta';
    });
    await this.speakResponse(texto);
  }

  private async descreverTrajeto(
    partida: Coordenadas,
    destino: Coordenadas & { descricao: string },
    trecho: string,
    foco: 'tempo' | 'distancia',
    modo: ModoViagem,
    partindoDaqui: boolean
  ): Promise<string> {
    const reta = distanciaEmMetros(partida, destino);
    if (partindoDaqui && reta < 80) {
      return `Você já está praticamente em ${destino.descricao}!`;
    }

    const Trecho = trecho.charAt(0).toUpperCase() + trecho.slice(1);
    try {
      const t = await this.localizacao.calcularTrajeto(partida, destino, modo);
      const meio = MODO_FALADO[modo];
      const transito = modo === 'carro' || modo === 'transporte' ? ', sem contar o trânsito' : '';
      let texto =
        foco === 'tempo'
          ? `${Trecho} são cerca de ${falarDuracao(t.segundos)} ${meio}${transito}, num percurso de ${falarDistancia(t.metros)}.`
          : `${Trecho} são cerca de ${falarDistancia(t.metros)} pelo caminho, mais ou menos ${falarDuracao(t.segundos)} ${meio}${transito}.`;
      if (modo === 'transporte') {
        texto += ' Os horários de ônibus e metrô aparecem no Google Maps.';
      }
      return texto;
    } catch (err) {
      console.warn('diagnostic: rota falhou, usando linha reta ->', err);
      return `Não consegui calcular o caminho pelas ruas agora, mas em linha reta, ${trecho} são cerca de ${falarDistancia(reta)}.`;
    }
  }

  /** "Tem uma farmácia próxima daqui?": acha a mais próxima, fala e abre o caminho no Google Maps. */
  private async handleLugarProximo(normalized: string, pedido: Extract<PedidoLocal, { tipo: 'proximo' }>): Promise<void> {
    const categoria = pedido.categoria;
    if (!categoria) {
      await this.falarEAbrirMapa(normalized, `Vou abrir o Google Maps com ${pedido.termo} perto de você.`, () =>
        this.localizacao.abrirBusca(pedido.termo)
      );
      return;
    }

    const artigo = categoria.artigo === 'a' ? 'a' : 'o';
    this.mostrarResposta(normalized, `Procurando ${categoria.nome} perto de você...`, 'Procurando...');

    let texto: string;
    let abrir: () => Promise<void> = () => this.localizacao.abrirBusca(categoria.busca);
    try {
      const aqui = await this.localizacao.obterPosicao(true);
      const lugar = await this.localizacao.lugarMaisProximo(categoria, aqui);
      if (!lugar) {
        texto = `Não achei ${artigo} ${categoria.nome} aqui perto no meu mapa. Vou abrir o Google Maps para procurar.`;
      } else {
        const proximo = artigo === 'a' ? 'mais próxima' : 'mais próximo';
        const qual = lugar.nome ? `${artigo} ${lugar.nome}` : `${artigo === 'a' ? 'uma' : 'um'} sem nome no mapa`;
        texto =
          `${artigo.toUpperCase()} ${categoria.nome} ${proximo} que encontrei é ${qual}, ` +
          `a uns ${falarDistancia(lugar.metros)} daqui em linha reta. Vou abrir o caminho no mapa.`;
        const modo: ModoViagem = lugar.metros < 1500 ? 'a_pe' : 'carro';
        this.ultimoDestino = { coords: lugar, modo };
        abrir = () => this.localizacao.abrirRota(lugar, modo);
      }
    } catch (err) {
      // Sem localização ou sem resposta do OpenStreetMap: o Google Maps tem a própria localização e busca.
      console.error('diagnostic: handleLugarProximo failed ->', err);
      texto = `Vou abrir o Google Maps com ${categoria.busca} perto de você.`;
    }

    await this.falarEAbrirMapa(normalized, texto, abrir);
  }

  /** Fala e depois abre o mapa. Não fica ouvindo: o app vai para segundo plano. */
  private async falarEAbrirMapa(normalized: string, texto: string, abrir: () => Promise<void>): Promise<void> {
    this.mostrarResposta(normalized, texto, 'Abrindo o mapa...');
    this.lastResponseText = texto;

    try {
      await this.speak(texto);
    } catch (err) {
      console.warn('diagnostic: fala antes de abrir o mapa falhou', err);
    }
    if (this.speechAborted) {
      return;
    }

    try {
      await abrir();
      this.ngZone.run(() => {
        this.statusText = 'Pronto. Toque para falar com a Kira.';
        this.resetAwaitingSave();
      });
    } catch (err) {
      console.error('diagnostic: abrir mapa falhou ->', err);
      const message = 'Não consegui abrir o Google Maps neste aparelho.';
      this.ngZone.run(() => (this.commandResponse = message));
      await this.speakResponse(message);
    }
  }

  private mostrarResposta(normalized: string, resposta: string, status = 'Comando reconhecido'): void {
    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = resposta;
      this.statusText = status;
    });
  }

  private async handleExitAppRequest(normalized: string): Promise<void> {
    const farewell = 'Até logo! Encerrando o aplicativo.';

    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = farewell;
      this.statusText = 'Encerrando o aplicativo...';
    });

    try {
      await this.speak(farewell);
    } catch (err) {
      console.warn('diagnostic: farewell speech before exit failed', err);
    }

    try {
      await App.exitApp();
    } catch (err) {
      console.error('diagnostic: App.exitApp failed ->', err);
      this.ngZone.run(() => {
        this.errorMessage = 'Não foi possível encerrar o aplicativo automaticamente.';
        this.errorAlertOpen = true;
        this.resetAwaitingSave();
      });
    }
  }

  private async handleTorchRequest(normalized: string, turnOn: boolean): Promise<void> {
    const responseText = turnOn ? 'Pronto, a lanterna está ligada.' : 'Pronto, a lanterna está desligada.';

    this.ngZone.run(() => {
      this.recognizedCommand = normalized;
      this.commandResponse = responseText;
      this.statusText = 'Comando reconhecido';
    });

    try {
      if (turnOn) {
        await Torch.enable();
      } else {
        await Torch.disable();
      }
      await this.speakResponse(responseText);
    } catch (err) {
      console.error('diagnostic: handleTorchRequest failed ->', err);
      const message = 'Não consegui controlar a lanterna do aparelho agora.';
      this.ngZone.run(() => {
        this.commandResponse = message;
        this.errorMessage = message;
        this.errorAlertOpen = true;
        this.statusText = 'Erro na lanterna';
        this.resetAwaitingSave();
      });
    }
  }

  private async speakResponse(text: string): Promise<void> {
    this.lastResponseText = text;
    await this.speak(text);

    if (this.speechAborted) {
      return;
    }

    this.ngZone.run(() => {
      this.awaitingSaveCommand = true;
      this.statusText = 'Pode falar outro comando, ou diga "salvar resposta" para guardar o texto.';
    });

    await this.listenForFollowUpCommand();
  }

  private async listenForFollowUpCommand(): Promise<void> {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition || this.speechAborted) {
      this.ngZone.run(() => {
        this.awaitingSaveCommand = false;
      });
      return;
    }

    this.saveListenActive = true;
    this.ngZone.run(() => {
      this.isListeningForSave = true;
    });

    // O reconhecimento de voz encerra sozinho após poucos segundos de silêncio,
    // então reiniciamos automaticamente até algo ser reconhecido ou a janela expirar.
    const deadline = Date.now() + this.saveListenWindowMs;
    let handled = false;

    while (this.saveListenActive && !this.speechAborted && Date.now() < deadline) {
      handled = await this.runFollowUpListenAttempt(SpeechRecognition);
      if (handled) {
        break;
      }
    }

    this.saveListenActive = false;
    this.ngZone.run(() => {
      this.isListeningForSave = false;
      if (!handled) {
        this.awaitingSaveCommand = false;
        if (!this.isSpeaking) {
          this.statusText = 'Pronto. Toque para falar com a Kira.';
        }
      }
    });
  }

  private runFollowUpListenAttempt(SpeechRecognition: any): Promise<boolean> {
    return new Promise(resolve => {
      this.followUpRecognition = new SpeechRecognition();
      this.followUpRecognition.lang = 'pt-BR';
      this.followUpRecognition.interimResults = false;
      this.followUpRecognition.maxAlternatives = 1;

      let settled = false;
      const finish = (result: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        this.followUpRecognition = undefined;
        resolve(result);
      };

      this.followUpRecognition.onresult = async (event: any) => {
        const transcript = (event.results[0][0].transcript || '').toLowerCase().trim();
        const normalized = this.normalizeTranscript(transcript);
        console.log('diagnostic: follow-up transcript=', normalized);

        finish(true);
        await this.processRecognizedCommand(normalized);
      };

      this.followUpRecognition.onerror = (ev: any) => {
        console.warn('diagnostic: follow-up speech error', ev);
        finish(false);
      };

      this.followUpRecognition.onend = () => {
        finish(false);
      };

      try {
        this.followUpRecognition.start();
      } catch (err) {
        console.error('diagnostic: follow-up speech start failed ->', err);
        finish(false);
      }
    });
  }

  async saveResponseToFile(): Promise<void> {
    if (!this.lastResponseText) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `kira-resposta-${timestamp}.txt`;

    try {
      await Filesystem.writeFile({
        path: filename,
        data: this.lastResponseText,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });

      this.ngZone.run(() => {
        this.commandResponse = `Resposta salva em: ${filename}`;
        this.statusText = 'Arquivo salvo com sucesso.';
        this.awaitingSaveCommand = false;
      });

      await this.speak('Pronto, a resposta foi salva no arquivo.');
    } catch (err) {
      console.error('diagnostic: saveResponseToFile failed ->', err);
      this.ngZone.run(() => {
        this.errorMessage = 'Não foi possível salvar a resposta em arquivo.';
        this.errorAlertOpen = true;
        this.statusText = 'Erro ao salvar arquivo';
        this.awaitingSaveCommand = false;
      });
    }
  }

  private stopFollowUpListening() {
    this.saveListenActive = false;

    if (!this.followUpRecognition) {
      return;
    }

    try {
      this.followUpRecognition.abort();
    } catch (err) {
      console.warn('diagnostic: follow-up recognition abort failed', err);
    }

    this.followUpRecognition = undefined;
    this.awaitingSaveCommand = false;
  }

  private isSaveCommand(normalized: string): boolean {
    return normalized.includes('salvar resposta');
  }

  private normalizeTranscript(transcript: string): string {
    return transcript
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[.,!?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async speak(text: string): Promise<void> {
    console.log('diagnostic: speak() entered with text=', text);
    this.speechAborted = false;
    this.ngZone.run(() => {
      this.isSpeaking = true;
    });

    try {
      await this.voz.falar(text);
      console.log('diagnostic: TextToSpeech.speak completed');
    } catch (err) {
      console.error('diagnostic: TextToSpeech.speak failed', err);
      throw err;
    } finally {
      this.ngZone.run(() => {
        this.isSpeaking = false;
      });
    }
  }

  // Remove marcações que soam mal quando lidas em voz alta (markdown, emojis, links).
  private sanitizeForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
      .replace(/[*#_`~>|]/g, ' ')
      .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
      .replace(/\s*\n+\s*/g, '. ')
      .replace(/([.!?:;,])\s*\.+/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private buildSystemInstruction(): string {
    const agora = new Date().toLocaleString('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return [
      'Você é a KIRA, uma assistente de voz brasileira, simpática e esperta, que conversa pelo celular.',
      'Sua resposta será lida em voz alta por um sintetizador, então escreva como uma pessoa fala:',
      '- Português do Brasil, tom natural e acolhedor, como uma amiga que entende do assunto.',
      '- Seja breve: em geral uma a três frases. Só se estenda se o usuário pedir detalhes.',
      '- Nada de markdown, listas, tópicos, títulos, emojis, links ou tabelas. Se houver vários itens, cite-os numa frase corrida.',
      '- Escreva números, siglas e símbolos do jeito que se fala quando isso ajudar a leitura (ex.: "vinte graus", não "20°C").',
      '- Vá direto ao ponto. Não repita a pergunta e não comece sempre com "Claro" ou "Ótima pergunta".',
      '- Varie as palavras e pode usar expressões leves do dia a dia, sem exagerar nas gírias.',
      '- Se a pergunta estiver ambígua ou incompleta (o reconhecimento de voz pode errar palavras), interprete o mais provável ou faça uma pergunta curta.',
      '- Se não souber algo ou não tiver acesso a dados em tempo real, diga isso com naturalidade, sem inventar.',
      '- Não diga que é um modelo de linguagem, a menos que perguntem.',
      '- Quando o usuário pedir uma ação que existe nas suas funções (fechar o aplicativo, lanterna, previsão do tempo, distância e tempo de viagem, caminho no mapa, lugar mais próximo, repetir, salvar a resposta), chame a função em vez de responder com texto, mesmo que ele use outras palavras. Se pedir algo que nenhuma função faz, como alarmes, mensagens ou ligações, explique com gentileza que ainda não consegue fazer.',
      '- Você sabe onde o usuário está por meio das funções: para perguntas com "daqui", "aqui", "perto de mim", distâncias, rotas ou clima, chame a função em vez de dizer que não sabe a localização.',
      `Agora é ${agora}.`,
    ].join('\n');
  }

  private getLlmHistory(): { role: 'user' | 'model'; text: string }[] {
    if (Date.now() - this.llmLastInteraction > HomePage.LLM_HISTORY_TTL_MS) {
      this.llmHistory = [];
    }
    return this.llmHistory;
  }

  private rememberLlmTurn(question: string, answer: string): void {
    this.llmHistory.push({ role: 'user', text: question }, { role: 'model', text: answer });
    const maxMessages = HomePage.LLM_HISTORY_MAX_TURNS * 2;
    if (this.llmHistory.length > maxMessages) {
      this.llmHistory = this.llmHistory.slice(-maxMessages);
    }
    this.llmLastInteraction = Date.now();
  }

  // O reconhecimento de voz às vezes transcreve "Kira" com grafias parecidas
  // (kyra, kiara, quira...) ou antepõe uma palavra de preenchimento antes dela,
  // então aceitamos variações e procuramos o gatilho nas duas primeiras palavras.
  private static readonly KIRA_TRIGGER_WORDS = ['kira', 'kyra', 'kiara', 'quira', 'kirah'];

  private matchKiraTrigger(normalized: string): string | null {
    const words = normalized.split(' ').filter(Boolean);
    const searchLimit = Math.min(2, words.length);

    for (let i = 0; i < searchLimit; i++) {
      if (HomePage.KIRA_TRIGGER_WORDS.includes(words[i])) {
        return words.slice(i + 1).join(' ').trim();
      }
    }

    return null;
  }

  /**
   * Ações do app que a IA pode pedir (function calling). Assim, qualquer jeito
   * de falar ("pode encerrar por hoje", "acende a luzinha") vira a ação certa,
   * mesmo sem estar na lista de frases do voice-commands.json.
   */
  private static readonly FUNCOES_IA = [
    { name: 'fechar_aplicativo', description: 'Fecha, encerra, sai ou desliga o aplicativo da Kira.' },
    {
      name: 'lanterna',
      description: 'Liga ou desliga a lanterna (flash) do celular.',
      parameters: {
        type: 'object',
        properties: { ligar: { type: 'boolean', description: 'true para ligar, false para desligar' } },
        required: ['ligar'],
      },
    },
    {
      name: 'previsao_do_tempo',
      description:
        'Previsão do tempo (chuva, sol, frio, calor, temperatura) para hoje ou os próximos dias, no local atual do usuário ou numa cidade citada.',
      parameters: {
        type: 'object',
        properties: {
          dia: {
            type: 'string',
            description: 'Dia perguntado, em português: "hoje", "amanhã", "depois de amanhã", "sábado", "fim de semana". Vazio se não disse.',
          },
          cidade: { type: 'string', description: 'Cidade citada pelo usuário. Vazio para o local onde ele está.' },
          assunto: { type: 'string', enum: ['chuva', 'sol', 'frio', 'calor', 'temperatura', 'geral'] },
        },
      },
    },
    {
      name: 'distancia_e_tempo_de_viagem',
      description:
        'Calcula a distância e o tempo de viagem do local atual do usuário (ou de uma origem citada) até um destino: endereço, rua, bairro, cidade ou lugar conhecido.',
      parameters: {
        type: 'object',
        properties: {
          destino: { type: 'string', description: 'Destino como o usuário falou, com a cidade se ele disse.' },
          origem: { type: 'string', description: 'Só se o usuário citou um ponto de partida diferente de onde ele está.' },
          modo: { type: 'string', enum: ['carro', 'a_pe', 'bicicleta', 'transporte'] },
          foco: { type: 'string', enum: ['tempo', 'distancia'], description: 'O que o usuário quer saber principalmente.' },
        },
        required: ['destino'],
      },
    },
    {
      name: 'abrir_rota_no_mapa',
      description: 'Abre o Google Maps com o caminho até um destino ("como chego em...", "me leva até...").',
      parameters: {
        type: 'object',
        properties: {
          destino: { type: 'string', description: 'Destino como o usuário falou.' },
          modo: { type: 'string', enum: ['carro', 'a_pe', 'bicicleta', 'transporte'] },
        },
        required: ['destino'],
      },
    },
    {
      name: 'lugar_mais_proximo',
      description:
        'Procura o estabelecimento mais próximo do usuário de um tipo (farmácia, posto de gasolina, hospital, padaria, mercado, restaurante...) e abre o caminho no Google Maps.',
      parameters: {
        type: 'object',
        properties: { tipo: { type: 'string', description: 'Tipo de lugar, em português, ex.: "farmácia".' } },
        required: ['tipo'],
      },
    },
    { name: 'repetir_ultima_resposta', description: 'Repete a última coisa que a Kira falou.' },
    { name: 'salvar_resposta', description: 'Salva a última resposta da Kira num arquivo de texto.' },
  ];

  private acaoDaFuncao(nome: string, args: any): AcaoIA | null {
    const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const modo = (v: unknown): ModoViagem =>
      v === 'a_pe' || v === 'bicicleta' || v === 'transporte' ? v : 'carro';
    const ehAqui = (v?: string) => !v || /^(aqui|daqui|local atual|minha localizacao|onde (eu )?estou)$/.test(normalizar(v));

    switch (nome) {
      case 'previsao_do_tempo': {
        const { dias, explicito } = diasDoTexto(texto(args?.dia));
        const assuntos = ['chuva', 'sol', 'frio', 'calor', 'temperatura', 'geral'];
        const cidade = texto(args?.cidade);
        return {
          tipo: 'tempo',
          pedido: {
            dias,
            diaExplicito: explicito,
            cidade: ehAqui(cidade) ? undefined : cidade,
            foco: assuntos.includes(args?.assunto) ? args.assunto : 'geral',
          },
        };
      }
      case 'distancia_e_tempo_de_viagem': {
        const destino = texto(args?.destino);
        const origem = texto(args?.origem);
        if (!destino) return null;
        return {
          tipo: 'distancia',
          destino,
          origem: ehAqui(origem) ? undefined : origem,
          modo: modo(args?.modo),
          foco: args?.foco === 'distancia' ? 'distancia' : 'tempo',
        };
      }
      case 'abrir_rota_no_mapa': {
        const destino = texto(args?.destino);
        return destino ? { tipo: 'rota', destino, modo: modo(args?.modo) } : { tipo: 'abrirMapa' };
      }
      case 'lugar_mais_proximo': {
        const tipo = texto(args?.tipo);
        if (!tipo) return null;
        const categoria = encontrarCategoria(tipo);
        return { tipo: 'proximo', categoria, termo: categoria?.busca ?? tipo };
      }
      case 'fechar_aplicativo':
        return 'exitApp';
      case 'lanterna':
        return args?.ligar === false ? 'torchOff' : 'torchOn';
      case 'repetir_ultima_resposta':
        return 'repeat';
      case 'salvar_resposta':
        return 'salvar';
      default:
        return null;
    }
  }

  private async queryLLM(question: string): Promise<RespostaIA> {
    const apiUrl = environment.llmApiUrl;
    const apiKey = environment.llmApiKey;

    if (!apiUrl || !apiKey) {
      throw new Error('LLM API não está configurada. Atualize src/environments/environment.ts.');
    }

    const historico = this.getLlmHistory();
    const requestBody = {
      systemInstruction: {
        parts: [{ text: this.buildSystemInstruction() }],
      },
      contents: [
        ...historico.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
        { role: 'user', parts: [{ text: question }] },
      ],
      tools: [{ functionDeclarations: HomePage.FUNCOES_IA }],
      generationConfig: {
        // Um pouco acima do padrão para variar o jeito de falar sem perder precisão.
        temperature: 0.8,
        // Teto de segurança; o tamanho real é controlado pela instrução acima.
        maxOutputTokens: 600,
      },
    };

    const urlWithKey = `${apiUrl}?key=${apiKey}`;
    console.log('diagnostic: queryLLM - enviando para Gemini:', apiUrl);
    console.log('diagnostic: queryLLM - pergunta:', question);

    const maxTentativas = 3;
    const tempoLimiteMs = 15000;

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      // Só vale tentar de novo em falhas passageiras: rede, tempo esgotado, 429 e 5xx.
      // Erros como chave inválida (400/403) falham na hora, sem fazer o usuário esperar.
      let podeRepetir = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), tempoLimiteMs);

      try {
        const response = await fetch(urlWithKey, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        console.log(
          `diagnostic: queryLLM - tentativa ${tentativa}/${maxTentativas} - status:`,
          response.status,
          response.statusText
        );

        const data = await response.json();
        console.log('diagnostic: queryLLM - resposta completa:', JSON.stringify(data));

        if (!response.ok) {
          const errorMessage =
            data?.error?.message ||
            data?.error?.errors?.[0]?.message ||
            data?.message ||
            response.statusText;

          console.error('diagnostic: queryLLM - erro HTTP:', errorMessage);
          podeRepetir = response.status === 429 || response.status >= 500;
          throw new Error(`Erro LLM: ${errorMessage}`);
        }

        const parts: { text?: string; thought?: boolean; functionCall?: { name: string; args?: any } }[] =
          data?.candidates?.[0]?.content?.parts ?? [];

        // A IA entendeu a frase como um pedido de ação do app.
        const chamada = parts.find(p => p.functionCall)?.functionCall;
        const acao = chamada ? this.acaoDaFuncao(chamada.name, chamada.args) : null;
        if (acao) {
          console.log('diagnostic: queryLLM - IA pediu a ação:', chamada?.name, JSON.stringify(chamada?.args));
          return { tipo: 'acao', acao };
        }

        const rawAnswer = parts
          .filter(p => !p.thought && p.text)
          .map(p => p.text)
          .join(' ')
          .trim();

        if (!rawAnswer) {
          return { tipo: 'texto', texto: 'Hum, não consegui pensar numa resposta agora. Pode tentar de novo?' };
        }

        const answer = this.sanitizeForSpeech(rawAnswer);
        this.rememberLlmTurn(question, answer);

        console.log('diagnostic: queryLLM - resposta final:', answer);
        return { tipo: 'texto', texto: answer };
      } catch (error) {
        console.error('diagnostic: queryLLM - erro:', error);

        if (!podeRepetir || tentativa >= maxTentativas) {
          throw error;
        }

        this.ngZone.run(() => {
          this.statusText = 'Só um instante...';
        });
        await this.wait(1500 * tentativa);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`Falha ao consultar a LLM após ${maxTentativas} tentativas.`);
  }

  private async listenForSound(duration = 3000): Promise<boolean> {
    if (!this.analyser) {
      return false;
    }

    const buffer = new Float32Array(this.analyser.fftSize);
    const threshold = 0.02;
    const interval = 150;
    const steps = Math.ceil(duration / interval);

    for (let i = 0; i < steps; i++) {
      await this.wait(interval);
      if (!this.analyser) {
        return false;
      }
      this.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let j = 0; j < buffer.length; j++) {
        sum += buffer[j] * buffer[j];
      }
      const rms = Math.sqrt(sum / buffer.length);
      console.log('diagnostic: listenForSound rms=', rms);
      if (rms > threshold) {
        return true;
      }
    }
    return false;
  }

  private async initAudio() {
    if (this.audioContext && this.stream) {
      return;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('navigator.mediaDevices.getUserMedia not available');
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        console.log('diagnostic: AudioContext created, state=', this.audioContext.state);
      }

      if (this.audioContext.state === 'suspended') {
        console.log('diagnostic: resuming suspended AudioContext...');
        await this.audioContext.resume();
        console.log('diagnostic: AudioContext resumed, state=', this.audioContext.state);
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        console.log('diagnostic: devices before getUserMedia ->', devices);
      } catch (e) {
        console.warn('diagnostic: enumerateDevices failed before getUserMedia', e);
      }

      const audioConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      };

      console.log('diagnostic: calling getUserMedia with constraints ->', audioConstraints);
      this.stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      console.log('diagnostic: getUserMedia success, tracks=', this.stream.getTracks());

      if (!this.stream || this.stream.getTracks().length === 0) {
        throw new Error('MediaStream obtained but no audio tracks available');
      }

      try {
        const source = this.audioContext.createMediaStreamSource(this.stream);
        console.log('diagnostic: MediaStreamAudioSourceNode created successfully');

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        source.connect(this.analyser);
        console.log('diagnostic: analyser connected successfully');
      } catch (audioErr) {
        console.error('diagnostic: error creating/connecting audio nodes ->', audioErr);
        throw new Error(`Audio node error: ${audioErr}`);
      }
    } catch (err) {
      console.error('diagnostic: initAudio failed ->', err);
      this.stopAudio();
      throw err;
    }
  }

  private async requestMicrophonePermission(): Promise<void> {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        // @ts-ignore
        const p = await navigator.permissions.query({ name: 'microphone' });
        if (p && p.state === 'denied') {
          throw new Error('Permissão de microfone negada');
        }
      } catch (e) {
        console.warn('navigator.permissions query failed', e);
      }
    }

    if (navigator.mediaDevices) {
      return;
    }

    throw new Error('API de microfone não suportada neste dispositivo');
  }

  private wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private stopAudio() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = undefined;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = undefined;
    }

    this.analyser = undefined;
  }
}

import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { AI, AIError, GenerateContentRequest, GoogleAIBackend, getAI, getGenerativeModel } from 'firebase/ai';
import { environment } from '../../environments/environment';

/** Plugin nativo (android/.../KiraAppCheckPlugin.java): token do App Check (Play Integrity). */
interface KiraAppCheckPlugin {
  obterToken(opcoes: { forcar: boolean }): Promise<{ token: string; expiraEm: number }>;
}
const KiraAppCheck = registerPlugin<KiraAppCheckPlugin>('KiraAppCheck');

/** Corpo no formato do generateContent do Gemini (o mesmo da API REST). */
export interface PedidoIA {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: string; parts: { text: string }[] }[];
  tools?: { functionDeclarations: unknown[] }[];
  generationConfig?: Record<string, unknown>;
}

/** Erro da IA; `podeRepetir` diz se vale tentar de novo (rede, tempo esgotado, 429, 5xx). */
export class ErroIA extends Error {
  constructor(
    mensagem: string,
    readonly podeRepetir: boolean
  ) {
    super(mensagem);
  }
}

/**
 * Chamada ao Gemini.
 *
 * Caminho principal: Firebase AI Logic, protegido pelo App Check. Não há chave secreta no app:
 * o token do App Check vem do plugin nativo (Play Integrity) e prova que é o app verdadeiro.
 *
 * TRANSIÇÃO: se o Firebase não estiver configurado ou falhar, usa a chave antiga
 * (`llmApiKey`). Depois de validar o Firebase no celular, apague `llmApiUrl`/`llmApiKey`
 * dos environments, revogue a chave e remova `gerarComChaveAntiga`.
 */
@Injectable({ providedIn: 'root' })
export class IaService {
  private ai?: AI;

  /** Há algum caminho configurado para falar com a IA? */
  configurada(): boolean {
    return this.firebaseConfigurado() || this.temChaveAntiga();
  }

  /** Devolve a resposta do Gemini (com `candidates`), no mesmo formato da API REST. */
  async gerar(pedido: PedidoIA, tempoLimiteMs: number): Promise<any> {
    if (this.firebaseConfigurado()) {
      try {
        const resposta = await this.gerarNoFirebase(pedido, tempoLimiteMs);
        console.log('diagnostic: IaService - resposta pelo Firebase');
        return resposta;
      } catch (err) {
        const erro = this.traduzirErroFirebase(err);
        if (!this.temChaveAntiga()) {
          throw erro;
        }
        console.warn('diagnostic: IaService - Firebase falhou, usando a chave antiga:', erro.message);
      }
    }

    if (this.temChaveAntiga()) {
      const resposta = await this.gerarComChaveAntiga(pedido, tempoLimiteMs);
      console.log('diagnostic: IaService - resposta pela chave antiga');
      return resposta;
    }

    throw new ErroIA('A IA não está configurada (Firebase ou chave).', false);
  }

  // ---------- Firebase AI Logic ----------

  private firebaseConfigurado(): boolean {
    const { apiKey, projectId, appId } = environment.firebase;
    return !!(apiKey && projectId && appId);
  }

  private async gerarNoFirebase(pedido: PedidoIA, tempoLimiteMs: number): Promise<any> {
    const modelo = getGenerativeModel(this.obterAI(), { model: environment.llmModelo }, { timeout: tempoLimiteMs });
    const resultado = await modelo.generateContent(pedido as unknown as GenerateContentRequest);
    return resultado.response;
  }

  private obterAI(): AI {
    if (!this.ai) {
      const app: FirebaseApp = initializeApp(environment.firebase, 'kira');
      // No navegador não há Play Integrity: sem App Check, o Firebase recusa a chamada
      // (quando a verificação está ativada) e a IA cai na chave antiga do environment.ts.
      if (Capacitor.isNativePlatform()) {
        initializeAppCheck(app, {
          provider: new CustomProvider({
            getToken: async () => {
              const { token, expiraEm } = await KiraAppCheck.obterToken({ forcar: false });
              return { token, expireTimeMillis: expiraEm };
            },
          }),
          isTokenAutoRefreshEnabled: true,
        });
      }
      this.ai = getAI(app, { backend: new GoogleAIBackend() });
    }
    return this.ai;
  }

  private traduzirErroFirebase(err: unknown): ErroIA {
    if (err instanceof AIError) {
      const status = err.customErrorData?.status;
      // Sem status = falha de rede ou tempo esgotado.
      const podeRepetir = !status || status === 429 || status >= 500;
      return new ErroIA(`Erro LLM (Firebase${status ? ` ${status}` : ''}): ${err.message}`, podeRepetir);
    }
    return new ErroIA(`Erro LLM (Firebase): ${err instanceof Error ? err.message : String(err)}`, true);
  }

  // ---------- TRANSIÇÃO: chave antiga (apagar depois de validar o Firebase) ----------

  private temChaveAntiga(): boolean {
    return !!(environment.llmApiUrl && environment.llmApiKey && !/YOUR_GEMINI/.test(environment.llmApiKey));
  }

  private async gerarComChaveAntiga(pedido: PedidoIA, tempoLimiteMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tempoLimiteMs);

    try {
      const response = await fetch(`${environment.llmApiUrl}?key=${environment.llmApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pedido),
        signal: controller.signal,
      });
      const data = await response.json();

      if (!response.ok) {
        const mensagem =
          data?.error?.message || data?.error?.errors?.[0]?.message || data?.message || response.statusText;
        throw new ErroIA(`Erro LLM: ${mensagem}`, response.status === 429 || response.status >= 500);
      }
      return data;
    } catch (err) {
      if (err instanceof ErroIA) {
        throw err;
      }
      // Rede ou tempo esgotado: vale tentar de novo.
      throw new ErroIA(`Erro LLM: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

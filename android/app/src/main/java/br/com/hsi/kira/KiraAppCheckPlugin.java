package br.com.hsi.kira;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.AppCheckProviderFactory;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

/**
 * Firebase App Check para a IA (Firebase AI Logic).
 *
 * O SDK JS do Firebase roda na WebView e não tem acesso ao Play Integrity; por isso o
 * token sai daqui e é entregue a ele por um CustomProvider (ver ia.service.ts).
 *
 * - Build de debug: usa o provedor de debug. Na primeira execução, o logcat mostra
 *   "Enter this debug secret into the allow list in the Firebase Console...": cadastre
 *   esse segredo no console (App Check > Apps > Gerenciar tokens de debug).
 * - Build de release: usa o Play Integrity (exige o SHA-256 da assinatura no Firebase
 *   e, na prática, o app instalado pela Play, ex.: teste interno).
 *
 * Sem o android/app/google-services.json o Firebase não existe e o método falha com
 * o código SEM_FIREBASE; a IA então usa a chave antiga (enquanto ela existir).
 */
@CapacitorPlugin(name = "KiraAppCheck")
public class KiraAppCheckPlugin extends Plugin {
	private static final String TAG = "KiraAppCheck";
	private boolean pronto;

	@PluginMethod
	public void obterToken(PluginCall call) {
		if (!preparar()) {
			call.reject("Firebase não configurado (falta o google-services.json).", "SEM_FIREBASE");
			return;
		}
		boolean forcar = Boolean.TRUE.equals(call.getBoolean("forcar", false));
		FirebaseAppCheck.getInstance()
			.getAppCheckToken(forcar)
			.addOnSuccessListener(token -> {
				JSObject resposta = new JSObject();
				resposta.put("token", token.getToken());
				resposta.put("expiraEm", token.getExpireTimeMillis());
				call.resolve(resposta);
			})
			.addOnFailureListener(erro -> {
				Log.w(TAG, "Falha ao obter o token do App Check", erro);
				call.reject(erro.getMessage(), "FALHA_APP_CHECK", erro);
			});
	}

	private synchronized boolean preparar() {
		if (pronto) {
			return true;
		}
		Context contexto = getContext().getApplicationContext();
		if (FirebaseApp.getApps(contexto).isEmpty() && FirebaseApp.initializeApp(contexto) == null) {
			return false;
		}
		FirebaseAppCheck appCheck = FirebaseAppCheck.getInstance();
		appCheck.installAppCheckProviderFactory(fabrica(contexto));
		appCheck.setTokenAutoRefreshEnabled(true);
		pronto = true;
		return true;
	}

	private AppCheckProviderFactory fabrica(Context contexto) {
		boolean depuravel = (contexto.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
		if (depuravel) {
			// A biblioteca de debug só entra no build de debug (debugImplementation),
			// por isso é carregada por reflexão: no release ela nem existe.
			try {
				Class<?> classe = Class.forName("com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory");
				Log.i(TAG, "Usando o provedor de debug do App Check");
				return (AppCheckProviderFactory) classe.getMethod("getInstance").invoke(null);
			} catch (Exception e) {
				Log.w(TAG, "Provedor de debug indisponível; usando o Play Integrity", e);
			}
		}
		return PlayIntegrityAppCheckProviderFactory.getInstance();
	}
}

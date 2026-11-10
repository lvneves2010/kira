# KIRA (K.I.R.A. — Kinetic Interface for Responsive Automation)

Assistente virtual por voz para Android, da **Help Soluções em Informática (HSI)**. O usuário fala um comando e a KIRA responde em voz. Os recursos são comandos locais (`voice-commands.json`), consulta à IA (Gemini) quando a frase começa com "Kira", previsão do tempo, lanterna e salvar a resposta em arquivo.

- Repo: https://github.com/lvneves2010/kira. Antes se chamava `play-it-right`, e o projeto já se chamou "Jarvis" e "Play it Right".
- applicationId: `br.com.hsi.kira`. **Não pode mudar depois de publicado na Play.** O app antigo `com.playitright.app` é outro app no Android e precisa ser desinstalado à parte.
- Projetos irmãos em `C:\repos\HSI`: `planevento` (mesma stack, serviu de modelo para a abertura, o rodapé, o AdMob e a assinatura), `marcador-truco` (Flutter, a origem do padrão de rodapé HSI) e `leoneves-site` (onde vai ficar a política de privacidade).

## Stack

- Ionic 8 + Angular 20, com **componentes standalone** (diferente do planevento, que usa NgModules) + **Capacitor 8**.
- **O Capacitor 8 exige Node 22.** O Node global da máquina é o 20 (nvm-windows). Não troque o global: use `export PATH=/c/nvm/v22.23.2:$PATH`.
- Gradle precisa de JDK 21: `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`.
- Android: minSdk 24, compile/target 36 (`android/variables.gradle`).

## Estrutura

- `src/app/abertura`: tela de abertura (~3 s; um toque pula) com ícone, nome e rodapé completo da HSI. A rota `''` redireciona para ela.
- `src/app/home`: tela principal (voz), com o rodapé compacto em `ion-footer`. Ao entrar, mostra o banner do AdMob.
- `src/app/compartilhado/rodape-empresa`: logo HSI + versão. Com `compacto`, mostra só o logo e o número. Segue o padrão do planevento e do marcador-truco.
- `src/app/services/anuncios.service.ts`: AdMob (`@capacitor-community/admob`), cópia do planevento.
- `src/app/services/voice-commands.*`, `weather.service.ts`: comandos e previsão do tempo.

## Versão

Fonte única: `"version"` do `package.json`. O rodapé lê de lá e o `android/app/build.gradle` também: `versionName` é a versão e `versionCode` = MAJOR·10000 + MINOR·100 + PATCH. **Suba a versão no package.json antes de cada envio à Play.** A numeração recomeçou em 1.0.0 com o novo applicationId.

## Environments e chave da IA

- `src/environments/environment.ts` e `environment.prod.ts` estão no `.gitignore`. Para criá-los, copie dos `.example` e preencha `llmApiKey` e `admobBannerAndroid`.
- **A chave do Gemini vai embutida no APK.** Qualquer pessoa extrai do app publicado. Antes da Play, passe a chamada da IA por um backend/proxy (ou ao menos restrinja e limite a chave no Google Cloud). A chave antiga também ficou no histórico público do git e precisa ser revogada.

## Publicidade (AdMob)

- O fluxo é igual ao do planevento: consentimento UMP (GDPR/LGPD) → `AdMob.initialize()` (no `AppComponent`) → banner 320×50 ancorado embaixo, só na home e nunca na abertura. O banner é nativo e fica por cima da WebView. O evento `SizeChanged` grava `--altura-anuncio`, e `ion-app` ganha esse `margin-bottom` (`global.scss`).
- O botão "Privacidade dos anúncios" fica no menu de configurações e só aparece quando o UMP exige.
- IDs: fora do build de produção, ou com `admobBannerAndroid` vazio no `environment.prod.ts`, o app usa o **ID de teste do Google**. O App ID real vai em `android/gradle.properties` (`admobAppId=`). Sem ele, o manifest recebe o App ID de teste.

## Ícone

- Fonte: `src/assets/icon/favicon.svg` (núcleo com "K" e órbita sobre fundo #12192d). Para regerar os mipmaps: `npm run generate:icons`.
- Ícone da Play Store (512×512, quadrado cheio): `store/icone_playstore_512.png`.
- O logo HSI não é o ícone do app. Ele aparece só no rodapé (`src/assets/logo_hsi.png`).

## Comandos

```bash
export PATH=/c/nvm/v22.23.2:$PATH
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"

npm install
npm start                                  # navegador
npm run lint
npm run build:android                      # ng build (produção) + cap sync android
cd android && ./gradlew assembleDebug      # APK de debug
cd android && ./gradlew bundleRelease      # AAB para a Play (exige key.properties)
```

O celular de testes é um Xiaomi. Ele pede confirmação na tela a cada `adb install`.

## Play Store (pendências)

- **Upload key**: gerar um `.jks` com `keytool` e criar `android/key.properties` com `storeFile` (relativo a `android/`), `storePassword`, `keyAlias` e `keyPassword`. Os dois estão no `.gitignore`; **nunca commitar**. Guarde backup fora do repo.
- Conta da Play de **organização** em nome da HSI (LEONARDO VINICIUS NEVES LTDA), a mesma do planevento e do marcador-truco.
- Antes do primeiro envio:
  - criar o app no AdMob e preencher `admobAppId` e `admobBannerAndroid`;
  - marcar "Contém anúncios";
  - preencher o Data safety: áudio do microfone (reconhecimento de voz), localização aproximada/precisa (previsão do tempo), texto enviado ao Gemini e ID de publicidade (AdMob);
  - ter uma política de privacidade que cite microfone, localização, IA de terceiros e AdMob;
  - resolver a chave do Gemini (seção acima).

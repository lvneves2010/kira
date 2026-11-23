# KIRA (K.I.R.A. — Kinetic Interface for Responsive Automation)

Assistente virtual por voz para Android, da **Help Soluções em Informática (HSI)**. O usuário fala um comando e a KIRA responde em voz. Os recursos são comandos locais (`voice-commands.json`), consulta à IA (Gemini) quando a frase começa com "Kira", previsão do tempo, lanterna e salvar a resposta em arquivo.

- Repo: https://github.com/lvneves2010/kira. Antes se chamava `play-it-right`, e o projeto já se chamou "Jarvis" e "Play it Right".
- applicationId: `br.com.hsi.kira`. **Não pode mudar depois de publicado na Play.** O app antigo `com.playitright.app` é outro app no Android e precisa ser desinstalado à parte.
- **Pasta de trabalho: `C:\repos\HSI\kira`**, um clone limpo do GitHub criado em 2026-11-10.
  - A pasta antiga `C:\repos\HSI\jarvis` foi apagada em 2026-11-10, depois de conferir que não tinha nada que faltasse aqui.
  - Para apagar pastas com caminhos longos no Windows (ex.: `node_modules`), use `cmd /c 'rd /s /q "\\?\C:\caminho"'`. O `Remove-Item` falha nesses casos.
- O que o clone **não** traz (está no `.gitignore`) e foi copiado à mão da pasta antiga:
  - `src/environments/environment.ts` e `environment.prod.ts`, com a configuração do Firebase e a chave antiga do Gemini.
  - Se perder esses arquivos, recrie a partir dos `.example`.
  - `node_modules` e as pastas geradas do Android saem de `npm ci` + `npm run build:android`.
- Celular de testes: Xiaomi (modelo 25080RABDG). O app instalado é o `br.com.hsi.kira`. O app antigo `com.playitright.app` (o mesmo nome "K.I.R.A." e o mesmo ícone) deve ser desinstalado. Para conferir: `adb shell pm list packages | grep -E "kira|playitright"`.
- Projetos irmãos em `C:\repos\HSI`: `planevento` (mesma stack, serviu de modelo para a abertura, o rodapé, o AdMob e a assinatura), `marcador-jogos` (Flutter, a origem do padrão de rodapé HSI) e `leoneves-site` (onde vai ficar a política de privacidade).

## Stack

- Ionic 8 + Angular 20, com **componentes standalone** (diferente do planevento, que usa NgModules) + **Capacitor 8**.
- **O Capacitor 8 exige Node 22.** O Node global da máquina é o 20 (nvm-windows). Não troque o global: use `export PATH=/c/nvm/v22.23.2:$PATH`.
- Gradle precisa de JDK 21: `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`.
- Android: minSdk 24, compile/target 36 (`android/variables.gradle`).

## Estrutura

- `src/app/abertura`: tela de abertura (~3 s; um toque pula) com ícone, nome e rodapé completo da HSI. A rota `''` redireciona para ela.
- `src/app/home`: tela principal (voz), com o rodapé compacto em `ion-footer`. Ao entrar, mostra o banner do AdMob.
- `src/app/compartilhado/rodape-empresa`: logo HSI + versão. Com `compacto`, mostra só o logo e o número. Segue o padrão do planevento e do marcador-jogos.
- `src/app/services/anuncios.service.ts`: AdMob (`@capacitor-community/admob`), cópia do planevento.
- `src/app/services/voice-commands.*`, `weather.service.ts`: comandos e previsão do tempo.
- `src/app/services/pedidos-de-local.ts` + `localizacao.service.ts`: perguntas que usam a localização (seção abaixo).

## Localização (distância, rota, lugar próximo, tempo)

- `pedidos-de-local.ts` é um interpretador puro (sem rede) que roda **antes** do `voice-commands.json`. Ele reconhece:
  - distância/tempo ("quanto tempo daqui até a avenida paulista", "distância de SP até Porto Alegre");
  - rota ("como chego no ibirapuera" abre o Google Maps; "abre o mapa" usa o último destino calculado);
  - lugar próximo ("tem farmácia perto daqui": fala o nome e a distância e abre o caminho no Google Maps).
- O tempo continua sendo acionado pelo JSON, mas o `interpretarPedidoDoTempo` extrai dia, cidade e assunto (sol, chuva, frio...).
- O que o interpretador não entender vai para a IA, que tem as funções equivalentes (`distancia_e_tempo_de_viagem`, `abrir_rota_no_mapa`, `lugar_mais_proximo`, `previsao_do_tempo` com dia/cidade).
- Serviços gratuitos, sem chave e sem cartão, todos de uso justo (para muito volume, é preciso servidor próprio ou pago):
  - endereço → coordenadas: Photon (komoot) → cidade de nome exato no Open-Meteo → Nominatim;
  - rota: OSRM do FOSSGIS (`routing.openstreetmap.de`), **sem trânsito**;
  - lugar próximo: Nominatim (`[amenity=pharmacy]` em caixas crescentes, no máximo 1 consulta/s) → Overpass → busca do Google Maps.
- No celular, as chamadas usam `CapacitorHttp` com User-Agent `KIRA/<versão>` (o Overpass recusa User-Agents genéricos). O Google Maps abre pelo `@capacitor/app-launcher`.
- Para testar o interpretador sem celular: compile `pedidos-de-local.ts` com `tsc` e chame `interpretarPedidoDeLocal(frase)` no Node.

## Voz da KIRA

Tudo fica em `src/app/services/voz.service.ts`, e a escolha é feita no menu de configurações. Se a voz escolhida falhar, a KIRA usa a voz do aparelho.

- **Padrão: voz natural (Supertonic 2, voz feminina F3, int8)**, offline, com o sherpa-onnx.
  - Plugin nativo: `android/app/src/main/java/br/com/hsi/kira/KiraVozPlugin.java`, registrado no `MainActivity`.
  - **Os arquivos ficam fora do git:** o modelo (~96 MB, em `android/app/src/main/assets/supertonic/`) e o `.aar` do sherpa-onnx (~49 MB, em `android/app/libs/`). Recrie com `python scripts/preparar_voz_natural.py`. Sem eles, o build do Android falha.
  - Configuração validada em testes: `sid` 2 (F3), `lang=pt`, **12 passos** (com 5 a fala sai truncada) e **sem semente fixa** (com ela aparecem trechos em loop). O texto é gerado frase por frase.
  - Frases com mais de 60 caracteres são divididas nas vírgulas, porque o Supertonic só entrega o áudio com o trecho inteiro pronto. O silêncio das pontas é aparado nessas emendas, e a pausa fica em ~0,2 s. Com isso o primeiro som de uma resposta longa caiu de ~3,5 s para 0,7–1,4 s.
  - **Supertonic 3, testada e descartada (2026-11-23):** a voz F5 (sid 4) soa melhor, mas no Xiaomi ela leva 0,8–1,0 s para gerar cada segundo de fala (a v2 leva 0,2 s), e o modelo passa de 96 para 145 MB. A F5 da v2 não soa igual à da v3.
  - No Xiaomi de testes, o primeiro som sai em ~0,7 s, com RTF de 0,2 a 0,4. O APK de debug tem ~160 MB.
  - **Licença OpenRAIL-M:** o uso comercial é permitido, mas as restrições de uso precisam ser repassadas ao usuário. Inclua isso nos termos e na política de privacidade antes da Play. A licença vai em `assets/supertonic/LICENSE-modelo.txt`, e o crédito aparece no menu.
  - **Rollback:** existe a tag `antes-supertonic`. Use `git revert --no-edit antes-supertonic..HEAD` (para reverter só os commits da voz, liste-os com `git log antes-supertonic..HEAD`) e apague as duas pastas acima.
- **Voz do aparelho:** usa o Google TTS e prefere as vozes "network" (neurais). Sem internet, troca para a versão offline da mesma voz.
- **Leda (Gemini TTS): removida na 1.3.2.** Tinha só ~10 falas por dia por projeto e era o último uso da chave do Gemini no APK. Quem a tinha escolhido volta para a voz natural.
- **Já testado e descartado (2026-11-17):** vozes neurais offline no celular.
  - Piper (miro, jeff) e Coqui: masculinas, com sotaque carioca. A Piper dii é feminina, mas a licença é não comercial.
  - Pocket TTS português (voz "vera") com o sherpa-onnx: engolia o começo das frases (~11% de palavras perdidas), errava frases com menos de 6 palavras e aumentava o APK de 10 MB para 248 MB.
  - O código está no commit `bb248fd`, revertido em seguida.

## Versão

Fonte única: `"version"` do `package.json`. O rodapé lê de lá e o `android/app/build.gradle` também: `versionName` é a versão e `versionCode` = MAJOR·10000 + MINOR·100 + PATCH. **Suba a versão no package.json antes de cada envio à Play.** A numeração recomeçou em 1.0.0 com o novo applicationId.

## IA (Gemini pelo Firebase AI Logic)

- Tudo passa por `src/app/services/ia.service.ts`, chamado pelo `queryLLM` da home. O corpo da requisição é o mesmo da API REST do Gemini (function calling incluído).
- **Caminho principal: Firebase AI Logic** (SDK JS `firebase`, backend "Gemini Developer API") protegido pelo **App Check**. Não há segredo no APK.
  - O SDK JS roda na WebView e não tem Play Integrity. O token vem do plugin nativo `android/.../KiraAppCheckPlugin.java` (registrado no `MainActivity`) e entra no SDK por um `CustomProvider`.
  - Build de debug: provedor de debug. O logcat mostra "Enter this debug secret into the allow list..."; cadastre esse token no console (App Check > Apps > Gerenciar tokens de debug).
  - Build de release: Play Integrity. Exige os SHA-256 das chaves de assinatura (upload e da Play) no Firebase e, na prática, o app instalado pela Play (teste interno).
  - Precisa do `android/app/google-services.json` (o `build.gradle` só aplica o plugin `google-services` se ele existir) e de `firebase: { apiKey, projectId, appId }` nos environments.
- **Custo zero:** projeto no plano **Spark, sem conta de faturamento**, e backend "Gemini Developer API" (o Vertex exige faturamento). Quando a cota gratuita acaba, a chamada é recusada (429), sem cobrança. A cota é do projeto (todos os usuários somados); defina um limite por usuário no console do AI Logic.
- **Transição:** se o Firebase não estiver configurado ou falhar, o `IaService` usa a chave antiga (`llmApiUrl`/`llmApiKey`). Depois de validar o Firebase no celular, apague esses campos e o `gerarComChaveAntiga`, e **revogue a chave** (ela também está no histórico público do git). Ponto de recuperação: tag `antes-firebase`.
- No navegador (`npm start`) não há App Check, então a IA usa a chave antiga do `environment.ts`.
- Evolução possível (adiada): Gemini Nano no aparelho via Firebase AI Logic híbrido. No aparelho não há function calling nem conversa com várias rodadas, e o português não foi validado.

## Environments

- `src/environments/environment.ts` e `environment.prod.ts` estão no `.gitignore`. Para criá-los, copie dos `.example` e preencha `firebase`, `llmApiKey` (transição) e `admobBannerAndroid`.

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
- Conta da Play de **organização** em nome da HSI (LEONARDO VINICIUS NEVES LTDA), a mesma do planevento e do marcador-jogos.
- Antes do primeiro envio:
  - criar o app no AdMob e preencher `admobAppId` e `admobBannerAndroid`;
  - marcar "Contém anúncios";
  - preencher o Data safety: áudio do microfone (reconhecimento de voz), localização aproximada/precisa (previsão do tempo, distâncias e lugares próximos; as coordenadas vão para Open-Meteo, Photon, OSRM/FOSSGIS e Nominatim/Overpass), texto enviado ao Gemini pelo Firebase, App Check (integridade do app) e ID de publicidade (AdMob);
  - ter uma política de privacidade que cite microfone, localização (e os serviços de mapa que a recebem), IA de terceiros (no plano gratuito o Google pode usar o conteúdo para melhorar os modelos) e AdMob;
  - concluir a migração da IA para o Firebase e remover a chave antiga (seção "IA").

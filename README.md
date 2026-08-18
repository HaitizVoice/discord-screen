# Sala de Tela — Activity do Discord

Sala de compartilhamento de tela dentro do Discord. Uma pessoa transmite, todo mundo
assiste sem sair da Activity.

## Por que a arquitetura é assim

Duas restrições da plataforma definiram o desenho inteiro:

1. **A Activity roda num iframe cross-origin.** `getDisplayMedia()` é negado por padrão
   nesse contexto — só funcionaria se o Discord colocasse `allow="display-capture"` no
   iframe, o que não está documentado como concedido.
2. **WebRTC não é suportado em Activities.** A documentação de networking do Discord diz
   textualmente *"WebRTC is not supported"* e *"we currently only support websockets"*.
   Sem P2P, sem SFU, sem STUN/TURN.

A saída é capturar **fora** do sandbox e distribuir por WebSocket:

```
BROADCASTER                          SERVIDOR                  VIEWERS
Activity (iframe)                                              Activity (iframe)
  │ clica "Compartilhar"                                              │
  │ openExternalLink(PUBLIC_ORIGIN/share.html?t=…)                    │
  ▼                                                                   │
  aba normal do navegador  ← top-level, permissões completas          │
  │ getDisplayMedia()  ✅                                             │
  │ MediaStreamTrackProcessor → VideoEncoder (latencyMode realtime)   │
  └────── WebSocket binário ──────►  relay                            │
                                     guarda o decoderConfig           │
                                     pede keyframe a cada entrada     │
                                     fan-out ── WS via /.proxy/ ─────►│
                                                                      │ VideoDecoder → <canvas>
```

Só o transmissor sai para uma aba. Os espectadores nunca saem do Discord.

**WebCodecs, não MediaRecorder.** A primeira versão usava `MediaRecorder` + MSE e ficava
em ~3s de atraso. O container impõe um piso: o chunk só sai depois de fechado (timeslice),
e o MSE precisa acumular buffer para tocar sem engasgar. WebCodecs elimina os dois —
cada quadro é codificado, enviado e desenhado individualmente, sem container.

`WebCodecs` não é gated por Permissions Policy (diferente de `display-capture`), então
funciona dentro do iframe da Activity.

**Keyframe sob demanda.** Quando alguém entra na sala, o servidor pede um keyframe novo ao
transmissor em vez de guardar um antigo. A tela aparece em ~1 quadro. O relay também barra
quadros delta para quem ainda não recebeu keyframe — decoder frio só produz erro.

## Limitações que você está aceitando

| | |
|---|---|
| **Áudio** | Não implementado. WebCodecs exige `AudioEncoder`/`AudioDecoder` com sincronia manual via `AudioWorklet` — o container dava isso de graça, WebCodecs não. |
| **Transmitir do celular** | Impossível. `getDisplayMedia` não existe em navegador mobile. Só desktop. |
| **Assistir do celular** | Provavelmente não. WebCodecs no WebView do iOS é limitado. |
| **Navegador** | Chrome/Edge. `MediaStreamTrackProcessor` ainda é só Chromium. O Discord desktop é Chromium, então serve. |
| **Banda** | ~2 Mbps de egress **por espectador**. 5 pessoas ≈ 10 Mbps, ~4,5 GB/hora. |
| **UX** | O transmissor passa por um modal "você está saindo do Discord" e precisa manter a aba aberta. |
| **Transmissores simultâneos** | Um por sala. O segundo é recusado. |

## Configuração

### 1. Variáveis de ambiente

Copie `env.exemplo.txt` para `.env` na raiz e preencha:

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
PUBLIC_ORIGIN=https://seu-tunel.trycloudflare.com
SESSION_SECRET=<string longa e aleatória>
PORT=3001
NODE_ENV=development
```

> `PUBLIC_ORIGIN` **nunca** pode ser o domínio `*.discordsays.com`. Se a página de captura
> abrir dentro do proxy do Discord, ela volta a ser um contexto restrito e `getDisplayMedia`
> é bloqueado de novo — que é exatamente o problema que esse desenho existe para resolver.

Crie o `VITE_DISCORD_CLIENT_ID` no mesmo `.env` (o Vite lê da raiz):

```
VITE_DISCORD_CLIENT_ID=<mesmo valor de DISCORD_CLIENT_ID>
```

### 2. Discord Developer Portal

Em <https://discord.com/developers/applications>, na sua aplicação:

- **OAuth2** → copie Client ID e Client Secret.
- **Activities → Settings** → ative as Activities.
- **Activities → URL Mappings** → mapeie a raiz:

  | Prefix | Target |
  |---|---|
  | `/` | `seu-tunel.trycloudflare.com` *(sem `https://`)* |

## Rodando

### Sem Discord (desenvolvimento rápido)

O jeito mais rápido de ver funcionando. Não precisa de túnel nem de credenciais.

```bash
npm install
npm run dev
```

Abra `http://localhost:5173/?room=teste` em duas janelas do navegador. Clique em
**Compartilhar minha tela** numa delas — a outra recebe a transmissão.

### Com Discord

Um único túnel serve as duas pontas: a Activity (via proxy do Discord) e a página de
captura (acesso direto ao túnel). Por isso o túnel aponta para a **3001**, não para a 5173
do Vite — a página de captura precisa estar publicamente acessível fora do proxy.

**A ordem importa**, porque o túnel gera uma URL aleatória e o `VITE_DISCORD_CLIENT_ID`
é embutido no bundle em tempo de build.

1. **Portal**: crie a app, marque User Install + Guild Install em *Installation*, ative
   *Activities → Settings → Enable Activities*, e copie Client ID e Client Secret.

   Em *OAuth2 → Redirects*, adicione `https://127.0.0.1`. É só um placeholder — Activities
   autorizam dentro do próprio cliente e nunca redirecionam — mas sem pelo menos uma
   redirect cadastrada o `authorize` falha com
   `invalid_request: Missing "redirect_uri" in request`.

   Depois instale a app num servidor de teste abrindo
   `https://discord.com/oauth2/authorize?client_id=<SEU_CLIENT_ID>`. Sem instalar, ela não
   aparece no lançador de atividades.

2. **Túnel** (deixe rodando). Já existe um túnel dedicado com domínio fixo:
   ```bash
   cloudflared tunnel --config ~/.cloudflared/discord-screen.yml run discord-screen
   ```
   Ele serve `https://tela.suagateway.com.br` → `localhost:3001`. Config isolada de
   propósito: subir ou derrubar esta sala não encosta em `api.suagateway.com.br` nem no
   portfólio.

   Sem esse setup, um túnel descartável resolve — mas a URL muda a cada reinício:
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```

3. **`.env`**: preencha `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
   `VITE_DISCORD_CLIENT_ID` (mesmo valor do Client ID) e `PUBLIC_ORIGIN` com a URL do túnel.

4. **URL Mapping** em *Activities → URL Mappings*:

   | Prefix | Target |
   |---|---|
   | `/` | `tela.suagateway.com.br` *(sem `https://`)* |

5. **Build e start** — nesta ordem, senão o Client ID não entra no bundle:
   ```bash
   npm run build
   npm start
   ```

6. **Discord**: ative o Modo Desenvolvedor (*Configurações → Avançado*), entre num canal de
   voz do seu servidor de teste e abra a app pelo lançador de atividades.

> A URL do `cloudflared tunnel --url` muda a cada reinício. Quando isso acontecer, atualize
> `PUBLIC_ORIGIN` e o URL Mapping — mas **não precisa rebuildar**, `PUBLIC_ORIGIN` é lido
> pelo servidor em tempo de execução. Só reinicie o servidor.

### Testes

```bash
npm start          # em um terminal
npm run smoke      # em outro
```

Valida o relay ponta a ponta sem browser: autenticação por token, entrega do init segment
para quem entra antes e depois da transmissão, contagem de participantes, recusa de
transmissor duplicado e isolamento entre salas.

## Diagnóstico embutido

A Activity tem um botão **"Testar captura no iframe"**. Ele tenta `getDisplayMedia()`
direto de dentro do iframe e mostra o erro exato.

Se um dia o Discord passar a conceder `display-capture` às Activities, esse botão vai
funcionar — e aí dá para eliminar a aba externa e o modal de saída inteiros, transmitindo
direto de dentro da Activity. Vale testar de tempos em tempos.

## Estrutura

```
server/
  index.js          HTTP + WebSocket, troca de OAuth, emissão de tokens
  rooms.js          relay: salas, init segment, backpressure
  tokens.js         tokens assinados com HMAC (sem dependência externa)
  public/share.*    página de captura (roda FORA do iframe)
client/
  src/main.js       SDK do Discord, conexão WS, UI da sala
  src/player.js     MediaSource: remonta os chunks, poda buffer, persegue o vivo
scripts/smoke.mjs   teste do relay
```

## Protocolo

Quadros trafegam como binário puro:

```
[1B tipo: 1=keyframe 2=delta][8B timestamp do quadro][8B relógio de envio][payload]
```

O relógio de envio existe só para medir latência. É exato na mesma máquina; entre máquinas
diferentes o desvio de relógio o torna aproximado — daí o `≈` na interface.

Controle vai em JSON: `start`, `config`, `stop` (transmissor → servidor); `state`,
`stream-start`, `config`, `stream-stop`, `need-keyframe`, `error` (servidor → clientes).

## Detalhes que não são acidentais

- **`latencyMode: 'realtime'`** no encoder e **`optimizeForLatency: true`** no decoder.
  Sem eles, ambos acumulam quadros antes de emitir — é compressão melhor, mas é atraso.
- **`frame.close()`** depois de desenhar. `VideoFrame` segura memória de GPU; sem isso a
  aba trava em segundos.
- **Descartar quadro quando `encodeQueueSize > 2`.** Fila no encoder vira latência que
  nunca mais sai. Melhor perder um quadro do que carregar o atraso pelo resto da sessão.
- **`track.contentHint = 'text'`.** Diz ao encoder que é tela, não vídeo natural — mantém
  texto nítido em vez de suavizar bordas.
- **Reconfigurar o encoder quando o quadro muda de tamanho.** Acontece ao redimensionar a
  janela compartilhada.
- **Backpressure no relay.** Se o socket de um viewer acumula mais de 2 MB, o servidor
  descarta quadros para ele em vez de enfileirar. Sem isso, um espectador com internet ruim
  derruba o processo por consumo de RAM.
- **`/.proxy/`** em todo fetch e WebSocket feito de dentro da Activity — é assim que o
  proxy do Discord roteia para o seu servidor.

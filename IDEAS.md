# Ideas backlog

Features sob consideração pro Boop. Cada uma deve passar por uma sessão de
`/grill-me` antes de virar plano ou implementação. As seções são
autocontidas: quem for grilar uma não precisa do resto do arquivo.

Tiers refletem status, não interesse: o que tá com decisões fechadas e o
que ainda precisa de grill. Dentro de cada tier, a ordem reflete interesse
manifestado. Quando aparecer item bloqueado por pesquisa externa, abre
tier "Pesquisa pendente" no fim do arquivo.

---

## Pronto pra plano (decisões fechadas, aguardando issue + implementação)

### Watcher agents

Monitor automático de eventos externos. Generaliza o que `automations` já
fazem (cron + spawn) somando uma camada de diff de estado: o bot guarda o
último resultado da query e só notifica quando o estado muda.

Casos de uso reais: monitorar abertura de venda de ingresso, release de
produto, mudança de status em issue de tracker, novo email com label
específica, vaga publicada num site.

**Componentes que já existem:**
- `convex/automations.ts` (cron + spawn).
- Memória durável (potencial home pro estado anterior, ou tabela própria).
- Broadcast pra notificar o user.

**Decisões fechadas (pronto pra plano — ver issue):**
- **Storage**: feature flag na tabela `automations` (campos opcionais
  `notifyOnlyOnChange: bool`, `lastSnapshot: string`). Não é tabela
  separada nem memória. Watcher = automation com diff mode ligado.
- **Spawn output**: snapshot line-oriented gerado pela LLM. Runtime
  acrescenta ao `task` do user "uma linha por item, formato consistente,
  sem comentário". Pinned Haiku + temp 0 pra estabilidade.
- **Diff**: set-difference puro nas linhas. `additions = current - previous`.
  Notifica formato `Novo: <linha>` por adição. Removals (Saiu:) ficam pro
  v2 se um watcher real pedir.
- **Idempotência**: o próprio diff vs `lastSnapshot` É a idempotência. Sem
  JSON dedup, sem cooldown, sem dois modos. Tradeoff conhecido: página
  flappy re-dispara uma vez por flap; reopening genuíno depois de fechar
  por muito tempo pode ficar mudo. Aceito pro v1.
- **Granularidade**: shared worker existente (`tickAutomations`). Watchers
  piggyback no mesmo loop de 30s.
- **UX de criação**: dispatcher propõe em chat ("vou monitorar X a cada Y,
  ok?") antes de chamar `create_automation`. Sem drafts table no v1.
- **Failure handling**: try/catch no spawn. Erro ou output vazio → log run
  como failed, não atualiza `lastSnapshot`, não notifica. Sem sentinel
  (`__EMPTY__`), sem auto-disable.
- **First-tick**: silent baseline. Só grava o snapshot, não dispara.
- **MCP tools**: zero novos. `create_automation` ganha arg opcional
  `notifyOnlyOnChange`. List/toggle/delete inalterados.

### Imagens como input

Aceitar foto/imagem do user e processar. Casos: recibo, screenshot de erro,
foto de quadro branco, etiqueta de produto, comprovante. Vision já roda
nativo no modelo, então a infra é só receber attachment do canal de chat,
baixar, e passar como content block na chamada.

**Decisões fechadas (pronto pra plano):**
- **Receive surface**: só `message.photo` do Telegram (JPEG comprimido,
  ~1280px). Ignora `document` mesmo com mime `image/*`. Expansão futura é
  trivial se aparecer caso real.
- **Transporte**: base64 inline (`type: "base64"`, `media_type: "image/jpeg"`),
  pegando a maior versão do array `photo[]`. Sem coupling com URL temporário
  do Telegram nem token vazando.
- **Storage**: fire-and-forget. Não persiste em Convex storage; imagem some
  depois do turno. Privacidade é o default seguro pra recibo/comprovante.
- **`messages.content`**: salva `[imagem] {caption}` (ou só `[imagem]` se
  não vier caption). Modelo nos próximos turnos vê o marker, pipeline de
  memória/extract não trata como turno vazio.
- **OCR**: vision direto, sem tool dedicada de OCR.
- **Multi-imagem**: cada foto vira um turno. Sem agregação por
  `media_group_id`. Quando o debounce landar, agregação vai vir de graça.
- **Falha de download**: resposta curta ("não consegui baixar a imagem,
  manda de novo?") sem chamar o modelo, pra economizar token.
- **Usage tracking**: image tokens já vêm no `usage` da Anthropic;
  `aggregateUsageFromResult` captura sem mudança em schema.
- **Modelo**: usa o default do turno (Sonnet/Haiku têm vision). Quando
  "Modelo por tipo de turn" landar, presença de imagem vira sinal de
  roteamento (nunca rota pra modelo sem vision).

### Nudges baseados em commitments

Bot detecta promessas durante a conversa ("vou mandar email pra Maria até
sexta", "preciso ligar pro dentista amanhã") e cria uma task com `due` +
`nextNagAt`. Loop existente (`tickAutomations`, 30s) dispara nudges quando
`nextNagAt <= now`.

**Estado atual da base (já existe):**
- Tabela `tasks` com `description`, `status`, `due`. Schema reservou
  `nextNagAt` como "issue #12" no comentário do schema.
- Tools MCP: `create_task`, `list_tasks`, `mark_done`, `update_task`. Prompt
  do `create_task` já implementa "sem fishing" (só dispara com triggers
  tipo "anota", "me lembra de", "tenho que").
- Pipeline `extractAndStore` (fire-and-forget após cada turno) com prompt
  JSON de extração e logging de custo.
- Loop `tickAutomations` (30s) com pattern de envio Telegram + assistant
  message.

**Decisões fechadas (pronto pra plano):**
- **Tabela**: estende `tasks`, sem tabela paralela. Adiciona campos
  opcionais `source: "explicit" | "inferred"`, `nextNagAt: number`,
  `lastNudgedAt: number`. Migração é aditiva, não-breaking; tasks legacy
  ficam com `source=undefined` (display como `explicit`).
- **Detecção implícita**: estende o `extractAndStore` existente. Output JSON
  ganha array `tasks: [...]` em paralelo a `facts: [...]`. Custo marginal
  ~zero (mesma chamada LLM, mesmo prompt cache). Consumer novo grava em
  `tasks` via mutation interna `tasks.createInferred` com `source="inferred"`.
  `create_task` user-facing continua só pra `explicit`.
- **UX de criação**: silent insert. Sem followup ("anotei que..."). Se
  errou, user dispensa via "esquece a N" no due day. **Premature design
  flag**: revisitar quando tivermos taxa real de false positives — pode
  pedir confirmação ou pending state se LLM for over-eager. Sinal pra
  coletar: counter de `inferred` tasks que viram `closed` antes do nudge
  disparar.
- **Mecanismo de nudge**: `nextNagAt` por task, piggyback no
  `tickAutomations` loop (30s). Query nova `tasks.listDueForNudge` filtra
  `status=open AND nextNagAt <= now`. Pra cada match: dispara nudge,
  recalcula `nextNagAt`, atualiza `lastNudgedAt`.
- **Defaults de cadência** (todos em TZ do user via `BOOP_USER_TIME_ZONE`):
  - `due` date-only ("até sexta"): nudge 9h do due day, re-nudge 18h
    se ainda open.
  - `due` datetime ("sexta 14h"): nudge 30min antes, re-nudge no horário
    exato se ainda open.
  - `due` undefined: nunca nuda. Aparece em `list_tasks` mas não bipa.
  - Após o último nudge, fica "atrasada" silenciosa (já marcada em
    `list_tasks` via `task-tools.ts:228`).
- **Texto e canal do nudge**: hardcoded `Lembrete: {description}` (segunda
  rodada do mesmo dia prefixa `Ainda aberto:`). Canal espelha
  `runAutomation` em `automations.ts:62`: `sendTelegramMessage` +
  `messages.send` como assistant message. Sem LLM rewrite no v1.
- **Cancelamento implícito**: NÃO no v1. User precisa dizer "feito a N"
  via `mark_done`. Aceita ruído de tasks que nudaram à toa. Revisitar pro
  v2 com dados reais.
- **Recorrência**: NÃO no v1. Workaround via automations
  existentes: "todo domingo crie uma task pra ligar pra mãe" → automation
  dispara → chama `create_task`. Documentar no README de tasks.

**Sai do escopo do v1 (parking lot pro v2):**
- Cancelamento implícito ("já mandei o email" → close automático).
- Tool `reopen_task` (não precisa enquanto não houver close inferred).
- Recorrência nativa em `tasks`.
- Painel debug dedicado pra inferred tasks (debug app já enxerga `tasks`;
  o filtro por `source` é diff trivial quando virar dor).
- Override de cadência por task (nudge custom, snooze, multiple re-nudges).

---

## Quer fazer (precisa /grill-me primeiro)

### Modelo por tipo de turn

Roteia o turno pro modelo certo automaticamente. Chit-chat e self-inspection
no Haiku, dispatch e coisa de memória no Sonnet, research pesado no Opus.
Corta custo direto sem perder qualidade onde importa.

**Componentes que já existem:**
- `get_config` / `set_model` / `runtime-config.ts`.

**Decisões abertas:**
- Heurística de classificação. Opções: keyword/length-based no servidor (rápido
  e barato), classifier-LLM pequeno antes do dispatch (mais preciso, mais
  latência), ou deixar o próprio interaction agent decidir e re-spawn em
  outro modelo (mais caro).
- Override manual: user pode forçar um modelo por turno ("usa opus").
- O sub-agent (`spawn_agent`) também pode escolher modelo dele baseado na
  task, ou herda do interaction.
- Como medir o impacto antes/depois (custo médio por turno, latência média,
  taxa de "respondeu errado e teve que refazer").

### Precisão da transcrição de áudio

Hoje `server/local-stt.ts` chama whisper.cpp (`whisper-cli`) com modelo
configurável via `WHISPER_MODEL`, idioma `pt`, GPU opcional, sem prompt de
contexto e sem pré-processamento de áudio. Várias alavancas que o setup
atual não usa.

Caminhos possíveis (não mutuamente exclusivos):

- **Modelo maior.** Subir pra `large-v3` ou `large-v3-turbo`. Turbo é
  bem mais rápido e quase tão preciso quanto large-v3 pra pt. Custo: peso
  do arquivo e RAM. Vale benchmarkar com áudios reais antes.
- **Prompt de contexto.** whisper.cpp aceita `--prompt` pra enviesar o
  decoder. Popular dinâmico a partir da memória do user (nome, contatos
  frequentes, jargão de projetos, lugares que ele cita) reduz erros em
  nomes próprios, que é onde Whisper mais erra.
- **VAD (voice activity detection).** Recortar silêncio antes de
  transcrever evita hallucination em trechos mudos (whisper inventa frase
  em silêncio prolongado). whisper.cpp suporta via `--vad`. Alternativa:
  Silero VAD num passo separado.
- **Pré-processamento de áudio.** Noise suppression (rnnoise via filtro
  ffmpeg), normalização de loudness (`-af loudnorm`), high-pass pra
  remover rumble. Áudio do Telegram já vem comprimido (Opus), então
  ganho aqui é incremental mas existe.
- **Beam search e temperature.** `-bo` (best-of) e beam size maiores
  ajudam em áudio difícil. Custo: latência.
- **Pós-processamento por LLM.** Passar o transcript pelo modelo com o
  contexto da memória do user pra corrigir nomes próprios, datas mal
  ouvidas, e jargão. Barato e específico.
- **Provider em nuvem.** Groq Whisper (rápido, free tier generoso),
  Deepgram Nova-3 (custom vocab + diarização), OpenAI Whisper API,
  AssemblyAI, ElevenLabs Scribe (multi-language forte, diarização).
  Trade-off: latência (geralmente melhor que local em CPU), custo
  (geralmente baixo), privacidade (áudio sai da máquina).
- **Toggle local/cloud.** Env var ou comando in-chat ("usa cloud pra
  áudio"/"volta pra local") que vira o caminho default. Combina com
  o híbrido por confidence se o user quiser auto.
- **Híbrido.** Local default, cloud fallback quando confidence baixa
  (whisper expõe logprob no output JSON). Privacidade quando dá, precisão
  quando precisa.

**Decisões abertas:**
- Qual o gargalo real hoje? Erros em nomes próprios, em jargão, em áudios
  ruidosos, ou em geral? Isso muda a alavanca certa.
- Vale manter local-first (privacidade, custo zero) ou cloud é OK?
- Se híbrido, qual threshold de confidence aciona o fallback?
- Prompt de contexto: quanto mandar (ele tem limite). Top N memórias por
  recência? Por frequência? Por relevância semântica?
- Pós-processamento por LLM: vale o custo extra, ou só quando o transcript
  parece quebrado?
- Como medir o ganho objetivamente. WER (word error rate) num set de
  áudios reais com gabarito.

### "O que vc lembra de mim?"

Comando que mostra o que tá salvo na memória do user, agrupado por tema, em
linguagem natural. Pareia com edição direta pelo chat: "esquece X",
"atualiza meu endereço pra Y", "junta essas duas memórias".

**Componentes que já existem:**
- `recall` / `write_memory` em `convex/memoryRecords.ts`.
- Schema de memória.

**Decisões abertas:**
- Agrupamento: por tag/category já salva, ou clusterização semântica na hora?
- UX da edição: confirmar antes de apagar? Soft-delete vs hard-delete?
- Quanto mostrar de uma vez (paginação? top N por relevância?).
- "esquece X" precisa de matching fuzzy, não exact match.

### Audit log

Log auditável de tudo que o bot fez no nome do user: drafts enviados,
automations criadas/alteradas, memórias escritas, integrações chamadas. Com
replay (quem chamou o quê, com quais argumentos, qual foi a resposta).

**Componentes que já existem:**
- `messages`, `usageRecords`, `agents`. Pedaços do log já estão aí.

**Decisões abertas:**
- Tabela nova de `auditLog`, ou uma view filtrada das tabelas existentes?
- Granularidade: 1 entrada por tool call, ou 1 por turno?
- Retenção: guarda quanto tempo? Comprime depois de X dias?
- View no debug panel: linha do tempo filtrável por tipo/integração.

### Shower thoughts / talking points

Captura de ideias/observações soltas pra puxar depois num contexto
específico (geralmente social: rolê com a galera, encontro com colega,
ligação pra alguém da família). Categoria distinta das memórias semânticas
(fatos sobre o user) e dos commitments (tarefas com prazo). É uma fila de
"coisas que eu quero contar/comentar com X".

Casos de uso:
- "anota: queria falar com a galera sobre [X]".
- "tô indo encontrar a [pessoa], o que eu tinha pra contar pra ela?"
- "alguma ideia pra puxar papo no jantar?"
- Captura passiva durante conversa: bot detecta "queria falar pra alguém
  que..." e oferece anotar.

**Componentes que já existem:**
- Memória durável (potencial home, ou inspiração pra schema).
- Pattern de tools de memória (recall/write_memory).

**Decisões abertas:**
- Tabela separada (`talkingPoints` ou `sparks`) ou tag/category na memória
  existente. Separada parece mais limpa pra lifecycle e retrieval distintos.
- Tagging: livre pelo user ("pra galera", "pro João"), bot infere, ou
  ambos. Inferência reduz fricção mas pode classificar errado.
- Retrieval: por tag explícita ("o que eu tinha pra galera?"), por contexto
  detectado ("vou ver o João" puxa tag "pro João" automático), ou random
  ("me dá uma ideia pra puxar papo").
- Lifecycle: shower thought some depois que o user "usou" (marcou como
  contado), expira sozinho depois de N dias, ou fica pra sempre.
- Captura passiva vs ativa: só anota com comando explícito, ou bot detecta
  gatilhos ("queria falar pra alguém", "tive uma ideia pra contar")?
  Passiva é mais útil mas exige confirmação pra não virar coletor de tudo.
- Sobreposição com nudges de commitments: bot pode lembrar proativo ("você
  tem 2 sparks pra galera quando encontrar eles"), ou só responde sob
  demanda?
- Multi-pessoa: mesma ideia tagueada pra "galera" e "irmã" porque cabe nos
  dois contextos. Cópia ou shared?

### Visibilidade de contexto e consumo

Mostrar quanto da janela de contexto tá sendo usada e quanto foi gasto em
tokens/dólares, similar ao indicador do Claude Code. Hoje o user não tem
ideia se a conversa tá perto do limite, nem do custo acumulado.

Casos de uso:
- "quanto de contexto?" → resposta tipo "62k/200k usados (31%)".
- "quanto gastei hoje?" → custo do dia (ou da sessão, ou da semana).
- Indicador sempre visível no debug panel: barra de % usada da janela,
  contador de tokens da sessão, custo estimado.

**Componentes que já existem:**
- `usage.ts` (aggregateUsageFromResult, UsageTotals).
- Tabela `usageRecords` em Convex.
- Self-inspection pattern (`get_config`) pra adicionar nova tool.

**Decisões abertas:**
- Tool nova (ex `get_usage`) que o user invoca por chat, ou só painel
  visual no debug, ou ambos.
- Granularidade: turno atual, sessão, dia, semana, total.
- Quebrar o consumo do contexto por origem (system prompt, history,
  memória, tool definitions, output) ou só total.
- Estimar antes do turno (preview) ou só reportar depois.
- Custo: usar preço da API ou marcar como "API equivalent" pra plano
  Max5x (que não cobra por chamada).
- Threshold de aviso ("contexto em 80%, considere começar nova conversa").

### Multi-mensagem (debounce)

Quando o user manda 2-3 mensagens em sequência (pensando alto, ou raciocínio
quebrado em pedaços), o bot espera um curto intervalo antes de responder pra
não cortar o raciocínio nem responder o pedaço errado.

**Decisões abertas:**
- Onde mora o debounce. Server (timer in-memory por conversa) ou Convex
  (scheduled function que cancela e reagenda). In-memory é mais simples mas
  perde estado em restart.
- Janela de debounce: fixa (ex 5s) ou adaptativa (mais longa se o user tá
  digitando rápido)?
- Cancelar resposta em andamento se o user manda nova mensagem antes do bot
  finalizar.
- Edge: e se um spawn lento já tá rodando quando chega mensagem nova? Aborta?
  Aguarda?

### CI com testes + auto-merge real

Hoje o repo não tem test runner. Auto-merge no GitHub fica vazio porque
não tem check pra esperar (PRs do feature watcher mergearam instant). Pra
auto-merge virar uma feature de verdade (espera teste passar, evita
quebrar main), precisa antes ter cobertura mínima e gate de CI.

Caminho:

- **Test runner.** Instalar vitest (Vite já é dep do `debug/`, então a
  pegada é pequena). Configurar `pnpm test` no `package.json`.
- **Primeiros testes.** Mirar nos pure helpers que não dependem de I/O,
  Convex, ou LLM. Candidatos imediatos: `normalizeSnapshot` e
  `diffAdditions` em `server/automations.ts` (PRD do watcher já listou
  os casos: input vazio, sem mudança, adição única, replacement
  completo, duplicatas). Depois `validateSchedule`, helpers de usage.
- **Job de CI.** Workflow novo em `.github/workflows/` que roda em PR:
  `pnpm install --frozen-lockfile` + `pnpm test` + `pnpm exec tsc --noEmit`.
  Ignorar erros de `convex/_generated/*` que dependem de codegen com
  deployment ao vivo (ou rodar codegen no CI com deploy key se valer).
- **Branch protection.** Habilitar protection em `main` com o CI como
  required check. Aí `gh pr merge --auto` realmente espera.
- **Cobertura adiante.** Tools individuais (memória, automations,
  drafts) testáveis com Convex client mockado. Pipeline de extract /
  consolidação só vale teste se for pra travar regressão de prompt,
  não pra cobrir lógica.

**Decisões abertas:**
- Vitest config: jsdom (pra debug/) ou só node? Provavelmente os dois,
  separados por workspace.
- Mock do Convex: mock manual ou `convex-test`? `convex-test` cobre
  mutations/queries direto, mas exige tipos gerados.
- Coverage threshold no CI ou só métrica observável? Threshold cedo
  vira ruído; observável dá direção.
- Auto-merge default: habilitar `--auto` em todo PR via hook, ou só
  manual com `gh pr merge --auto`? Default só faz sentido depois que
  CI tá estável o bastante pra confiar.

### Boop em outros apps (CLI-first + MCP proxy)

Expor as capacidades do Boop pra fora do Telegram (Claude Code, Cursor,
Codex, ChatGPT desktop, app mobile próprio). Hoje toda a superfície é o
canal de chat e o debug dashboard; memória, automations, drafts,
integrações ficam presas lá.

Direção arquitetural (clarificada em voice):
- **Boop não é cliente MCP**. Tools nativas continuam sendo invocadas
  diretamente pelo agente, sem passar pelo wire MCP, pra não estourar a
  janela de contexto do app que tá chamando.
- A superfície externa do Boop é uma **CLI** (`boop recall ...`,
  `boop write_memory ...`, `boop list_automations`, etc.). Cada comando
  faz uma coisa só, sai com resultado em stdout.
- Em cima da CLI mora um **MCP proxy fino** que apresenta cada comando
  como uma tool MCP. O proxy é stateless: lê config, expõe N tools,
  roda o subprocess, retorna stdout. Outros apps falam MCP com o proxy;
  o proxy fala CLI com o Boop.
- Hot-reload: alterações no manifesto de comandos refletem sem
  restart, pra extensão ser barata.

Casos de uso:
- Plugar `recall` / `write_memory` no Claude Code pra continuidade de
  contexto entre Telegram e sessão de código.
- Delegar pesquisa do Cursor via `boop spawn ...` reaproveitando
  Gmail/Calendar do user.
- Listar / criar watchers da CLI direto, sem abrir Telegram.
- Expor a memória como fonte "quem é esse user" pra qualquer assistant
  que aceite MCP.

Componentes que já existem:
- Tools internas (memory, automations, drafts, self, integrations) já
  são MCP servers internos via `createSdkMcpServer` — a lógica é
  reutilizável; o que muda é a casca de entrada (CLI em vez de
  conversação).
- HTTP server com auth via `ADMIN_TOKEN` (`server/index.ts`).

Decisões abertas:
- Onde mora a CLI: subcomando do mesmo binário (`boop ...`), script
  separado, ou path no repo (`bin/boop`).
- Como o MCP proxy descobre os comandos: manifesto YAML/JSON, scan de
  diretório, anotação no código fonte.
- Auth: reusa `ADMIN_TOKEN` estático, gera per-app keys com scopes
  (`memory:read`, `automations:write`), ou OAuth.
- Quais tools expor. Leitura de memória é óbvia. Escrita cross-app
  gera conflito (qual app é fonte da verdade). Automations / watchers
  são perigosos (criar coisa por engano em outro app). Drafts são
  específicos do canal.
- Multi-instância vs single-user: hoje Boop é single-user. Se virar
  superfície pública mesmo que pessoal, precisa de identidade do
  caller, ou segue assumindo "uma instância = um user".
- Discoverability / packaging: instalador (`npx boop-mcp`) ou cada
  user hospeda o próprio e cola URL/path no config do app cliente.

### Codex como segunda opinião / stress-test

Plugar o Codex CLI (já presente no ambiente do user via plugin
`codex:codex-rescue`) como sub-agente do Boop pra dois usos:

- **Stress-test de ideia.** User joga um plano/decisão no chat ("tô
  pensando em X") e pede pra estressar. Boop dispara em paralelo
  Claude (advogado) e Codex (advogado-do-diabo), agrega as duas leituras
  e devolve um resumo com pontos de concordância e divergência.
- **Pesquisa cruzada.** Pergunta de pesquisa que poderia ir pra
  spawn_agent normal vai também pro Codex; runtime cruza as respostas
  e marca o que cada um citou (e o que só um deles citou).
- **Pergunta direta de "outro modelo".** User explicita ("pergunta
  isso pro Codex") e Boop encaminha sem orquestração.

Componentes que já existem:
- Plugin Codex Claude Code já disponível no ambiente local do user
  (skills `codex:codex-cli-runtime`, `codex:gpt-5-4-prompting`).
- Pattern de spawn_agent + execution-agent serve de base.
- aggregateUsageFromResult já lida com múltiplas chamadas por turno.

Decisões abertas:
- **Onde mora o Codex.** Mesma máquina (CLI local invocado via shell
  pelo execution-agent) ou API direta (xAI? OpenAI?). CLI local é o
  que o user já paga via assinatura.
- **Quando dispara consenso.** Sempre? Só quando user pede explícito
  ("estressa")? Heurística automática (turnos de "decisão" detectados)?
- **Formato da resposta agregada.** Lado-a-lado, merge editorial,
  bullet de divergências. Provavelmente bullet de divergências é o que
  agrega valor de fato.
- **Custo e latência.** Dois agentes por turno dobra ambos. Pra
  features tipo "/grill-me" o custo é justificado; pra default não.
- **Identidade no output.** Mostrar "Claude diz X / Codex diz Y" ou
  esconder a marca e só ressaltar os pontos. Esconder pode ficar
  esquisito quando discordam.
- **Captura/replay.** Salvar as duas saídas pra debug futuro
  (`agentLogs` ganha tipo `consensus_input` / `consensus_output`).
- **Sandbox.** Codex CLI tem network e filesystem amplos por default;
  pra essa flow ele só precisa receber a pergunta e devolver texto.
  Vale rodar com `--readonly` ou flags de safety.

### Builder mode (extensões via chat)

Sub-ideia que aparece naturalmente em cima da CLI + MCP proxy: deixar o
user pedir extensão por chat ("adiciona um comando que lista os PRs
abertos do meu GitHub"), o agente entende, gera o comando novo, e o hot
reload do proxy expõe a tool MCP imediatamente nos apps que tão
conectados.

Fluxo imaginado:
1. User no Telegram: "cria um comando `prs-abertos` que pega os PRs em
   review meu no GitHub".
2. Boop entende, gera a extensão (script ou definição declarativa),
   salva em algum diretório de plugins.
3. MCP proxy detecta o novo comando, expõe como tool sem restart.
4. Próxima sessão de Claude Code/Cursor já vê `boop__prs-abertos`.

Decisões abertas (todas):
- Linguagem da extensão: script (TS/JS executado pelo runtime do Boop)
  ou definição declarativa (YAML que mapeia "rode esta query do GitHub
  e formata assim") ou os dois.
- Sandbox: extensão gerada por LLM rodando com os mesmos privilégios
  do Boop é arriscado. Precisa de diff + confirmação? White-list de
  APIs? Container?
- Onde armazena (Convex, filesystem, gist privado).
- Rollback / versionamento (git no diretório de plugins?).
- Discovery interno: `list_extensions` / `delete_extension` como
  ferramentas do dispatcher.
- Conflito com tools existentes: o que se o nome colide com uma tool
  built-in.

### Lembretes que aprendem horário

Automation que infere horário ao invés de exigir cron fixo. Hoje você diz
"todo dia às 9", vira `0 9 * * *`. A ideia é tirar o horário da mão do user.

Dois sabores possíveis:

- **Convergência.** User pede "me lembra de tomar remédio todo dia" sem
  horário. Bot chuta um horário razoável, observa quando o user reage ao
  nudge (visualiza rápido, responde, age), calcula mediana ao longo de uns
  dias e ajusta o cron. Em uma semana converge.
- **Linguagem natural.** User fala "começo da manhã", "antes do almoço",
  "fim de tarde". Bot tem um modelo do dia do user (puxado de horários de
  outras automations já fixadas, ou do padrão de horário das mensagens) e
  traduz pra cron concreto.

**Decisões abertas:**
- Como medir "reagiu ao nudge": visualizou (read receipt), respondeu, agiu
  no que foi sugerido. Cada um tem viés.
- Quanto histórico precisa pra convergir com confiança.
- Quando a inferência tá estável o suficiente pra "trancar" o horário.
- Mostrar pro user quando o horário muda? Ou ajusta silencioso?

### Banking BR (Open Finance / agregação)

Integração com agregador bancário pra extrato, saldo, categorização de
gastos, contexto financeiro nas conversas.

**Pesquisa concluída** (2026-05-02): comparativo Pluggy / Belvo / Klavi /
Iniciador direto em [`docs/research/banking-br.md`](docs/research/banking-br.md).

**Síntese da pesquisa:**
- Piso público de produção é R$ 2.500/mês (Pluggy Basic). Belvo, Klavi,
  Pluggy Custom e Iniciador inteiros ficam atrás de "fale com vendas".
- Pluggy é ITP regulada pelo BC (Resolução 80/2021) → integrar via Pluggy
  significa **não** precisar de autorização Bacen própria.
- Boop sendo single-user (só os dados do mantenedor) → DPO e CNPJ não são
  obrigatórios. Isso muda no instante em que virar multi-user.
- Refresh tokens Open Finance duram 60min total; consent pode ser
  indeterminado desde abril/2024.
- POC viável de graça: trial Pluggy de 14 dias ou Belvo Test (até 25 links
  reais, US$ 0).

**Decisões abertas:**
- POC primeiro ou skip total? Recomendação da pesquisa: POC com
  Pluggy/Belvo trial pra ver se os dados puxados realmente agregam valor
  conversacional, antes de pensar em produção.
- Se POC valer a pena: que dado puxa primeiro? Extrato + saldo é o ROI
  mais óbvio (categorizar e responder "quanto gastei com Uber esse mês").
  Investimentos/cartão são complemento.
- Como surfacing isso no Boop: tool dedicada (`get_balance`, `list_recent_transactions`)
  ou fica como contexto passivo no system prompt? Tool dedicada custa
  menos token até virar comum.
- Privacy posture: dados financeiros vão pra memory consolidation? Se sim,
  consolidation pode escrever fatos como "user gastou X em Y" — vale o
  trade-off de utilidade vs sensibilidade?
- Quando re-avaliar produção: gatilhos (quero compartilhar com X, quero
  vender, etc.) vs prazo fixo.

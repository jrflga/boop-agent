# Open Finance BR — Comparativo de APIs de agregação para uso pessoal

- Data da pesquisa: 2026-05-02
- Contexto: agente conversacional pessoal (Boop), volume baixo (5-10 contas, ~1k transações/mês), uso não comercial.
- Versão dos providers: snapshots das páginas públicas em maio/2026 (Pluggy, Belvo, Klavi, Iniciador). Pricing pago atrás de "fale com vendas" em todos os casos relevantes.

## Prompt original

```
Compare as principais APIs brasileiras de Open Finance / agregação
bancária pra um app pessoal de finanças (volume baixo, não comercial).

1. Pricing: custo por conexão de conta, custo por transação puxada,
   free tier, mensalidade mínima, modelo de cobrança.
2. Cobertura: quais bancos PF tão suportados (Itaú, Bradesco, Santander,
   Nubank, Inter, C6, BB, Caixa, corretoras como XP, Rico, BTG).
3. Sandbox e onboarding: dá pra testar de graça? Precisa de CNPJ?
   Homologação Bacen? Quanto tempo até produção?
4. Tipos de dado expostos: extrato, saldo, cartão de crédito,
   investimentos, Pix, boletos.
5. OAuth flow: user redireciona pro banco e volta? Com que frequência
   precisa re-consent? Token expira em quantos dias?
6. SDK e docs: tem SDK JS/TS? Webhook pra novas transações? Qualidade
   da documentação?

Compare ao menos Pluggy, Belvo, Klavi, e a opção de ir via Iniciador
direto (ou outro player que aparecer relevante).

Termina a resposta com:
- Recomendação pra projeto pessoal de baixo volume.
- Estimativa de custo mensal pra 5-10 contas conectadas e ~1k
  transações/mês.
- Riscos regulatórios pra dev solo: precisa de DPO? CNPJ? autorização
  Bacen ou só do agregador?

Fontes obrigatórias com URL.
```

---

## Contexto regulatório (a base de tudo)

- Open Finance é um arranjo do Banco Central, regido por resolução conjunta. Em 2026 cobre ~95% das relações financeiras do país, com participação obrigatória pra instituições com >5M de clientes ativos desde a Resolução Conjunta BCB/CMN nº 10/2024 (vigência 1º/jan/2025). Fonte: <https://moveo.ai/pt/blog/open-finance-ia>.
- Token de acesso: 15 minutos. Refresh tokens podem ser usados até 3x, totalizando ~60 minutos. Fonte: <https://openfinancebrasil.atlassian.net/wiki/spaces/OF/pages/219480491>.
- Consentimento: historicamente limitado a 12 meses; em out/2023 o BC simplificou renovação e a partir de abr/2024 o cliente pode autorizar prazo indeterminado. Fonte oficial: <https://agenciagov.ebc.com.br/noticias/202310/bc-simplifica-renovacao-de-consentimentos-no-open-finance-e-amplia-prazo-de-validade-do-compartilhamento>. Resumo regulatório: <https://mapaempresariall.com.br/publicacao/2145/open-finance-bc-autoriza-compartilhamento-de-dados-por-tempo-indeterminado>.
- Para acessar dados, é preciso ser participante autorizado (transmissor/receptor) homologado pelo BC, ou usar um player regulado como "guarda-chuva". Fonte: <https://openfinancebrasil.org.br/modelo-de-participacao/> e <https://openfinancebrasil.atlassian.net/wiki/spaces/OF/pages/155910145>.

Implicação direta pro dev solo: você não vai tirar autorização Bacen pra um projeto pessoal. Tem que entrar via agregador regulado (Pluggy, Belvo, Iniciador, Klavi) ou usar a ferramenta freemium que o agregador oferece pra pessoa física.

---

## Pluggy

- Site: <https://www.pluggy.ai/> · Docs: <https://docs.pluggy.ai/>

### Pricing
- Free trial 14 dias, sem cartão, até 20 contas conectadas, API completa. Fonte: <https://www.pluggy.ai/pricing>.
- Plano Basic: a partir de **R$ 2.500/mês** (valor público). Inclui Open Finance + conexões diretas, payment initiation, suporte help desk, customização do widget. Fonte: <https://www.pluggy.ai/pricing>.
- Plano Custom: "fale com especialista" (preço não público).
- Não há pricing por conexão ou por transação publicado; cobrança é por mensalidade. Fonte: <https://www.pluggy.ai/pricing>.
- Existe historicamente um "Freemium" voltado a cooperativas/fintechs de crédito (anúncio de 2021), com acesso a API Core + Sandbox sem custo. Fonte: <https://inforchannel.com.br/2021/12/03/pluggy-apresenta-freemium-para-cooperativas-e-fintechs-de-credito/>. Status atual desse plano não está claro na página de pricing pública (ambíguo).
- "Meu Pluggy" (<https://meu.pluggy.ai/>) é um produto de consumo gratuito pra pessoa física: gerencia consentimentos e permite compartilhar dados com apps terceiros. Funciona enquanto o trial pluggy.ai estiver ativo; depois a conexão fica viva mas o conector não dá pra editar. Fonte: <https://github.com/andreroggeri/pynubank/discussions/431> e <https://inforchannel.com.br/2024/01/18/meu-pluggy-facilita-monitoramento-dos-dados-compartilhados-e-elaboracao-de-novas-aplicacoes/>.

### Cobertura
- Conectores PF (não regulados / scraping autorizado): Bradesco, Itaú, Banco do Brasil, Caixa, Inter, Mercado Pago, Safra. Fonte: <https://docs.pluggy.ai/docs/accounts-coverage>.
- Conectores PJ: Bradesco Empresas, Itaú Empresas, Santander Empresas, Banco do Brasil Empresas, Inter Empresas. Fonte: idem.
- Investimentos: XP Investimentos, BTG Pactual, Avenue, EQI, Empíricus, Necton. Fonte: idem.
- Open Finance regulado: ACCOUNTS, CREDIT_CARDS, TRANSACTIONS, IDENTITY, LOANS, INVESTMENTS, INVESTMENT_TRANSACTIONS, BROKERAGE_NOTES, EXCHANGE_OPERATIONS. Cobertura varia por instituição. Precisa pedir ativação ao time de vendas. Fonte: <https://docs.pluggy.ai/docs/open-finance-regulated>.
- Nubank e C6 não aparecem explicitamente na lista de coverage que consegui ver via WebFetch; provavelmente entram pelo lado Open Finance regulado (Nubank é participante obrigatório), mas isso não está confirmado em fonte pública que eu consegui resolver. Ambíguo.

### Sandbox e onboarding
- Trial 14 dias sem cartão, ambiente Dev limitado a 100 itens. Fonte: <https://www.pluggy.ai/pricing> e <https://docs.pluggy.ai/page/faq>.
- Pluggy diz que a plataforma pode ser usada por "qualquer usuário, empresa ou pessoa física". Fonte: <https://www.pluggy.ai/pricing> (CTA do plano Basic) e <https://meu.pluggy.ai/>.
- A homologação Bacen é da Pluggy, não sua: Pluggy Brasil Instituição de Pagamento LTDA (CNPJ 37.943.755/0001-30) é Iniciadora de Transação de Pagamento autorizada pelo BC nos termos da Resolução BCB nº 80/2021. Fonte: <https://www.pluggy.ai/legal> e <https://www.pluggy.ai/security>.

### Tipos de dado
- Conta corrente, saldo, cartão de crédito, transações, identidade, empréstimos, investimentos, transações de investimento, notas de corretagem, operações de câmbio. Fonte: <https://docs.pluggy.ai/docs/open-finance-regulated>.
- Pix: suportado via produto de payment initiation (incluído nos planos Basic e Custom). Fonte: <https://www.pluggy.ai/pricing>.

### OAuth e consent
- Fluxo: usuário entra no widget Pluggy, escolhe a instituição, é redirecionado pro banco, autoriza, volta. Pluggy reaproveita a infra Open Finance regulada do BC.
- Refresh: o consentimento Open Finance segue a regra geral do BC (12 meses ou indeterminado, dependendo do que o usuário autorizar). Token interno da Pluggy: token diário (token "daily updates" mencionado nos materiais). Fonte: <https://gaveaangels.org/open-banking-pluggy-lanca-plataforma-gratuita/>.

### SDK e docs
- SDK Node oficial: `pluggy-sdk` no npm e <https://github.com/pluggyai/pluggy-node>.
- SDK client-side: `pluggy-connect-sdk` (widget). Fonte: <https://www.npmjs.com/package/pluggy-connect-sdk>.
- Webhooks: configuráveis por item via `webhookUrl` no connect token. Eventos: `item/created`, `item/updated`, `item/error`, etc. Retry: 10 tentativas em 3 dias com backoff. Fonte: <https://docs.pluggy.ai/> (seção webhooks).
- Documentação em PT/EN, exemplos em TS funcionam.

---

## Belvo

- Site: <https://belvo.com/> · Docs: <https://developers.belvo.com/>

### Pricing
- Test (sandbox): **US$ 0**, sandbox + produção, customização do Connect Widget, "test live data — up to 25 real data links". Fonte: <https://belvo.com/plans-and-pricing/>.
- Launch: **US$ 1.000/mês**. Mesmas features. Fonte: idem.
- Growth: custom (fale com vendas). Fonte: idem.
- Não publica preço por link nem por transação.

### Cobertura
- Diz cobrir "+90% das contas bancárias na América Latina" via Open Finance. Fonte: <https://belvo.com/>.
- Lista detalhada por instituição fica numa página dedicada de "Banking Aggregation (Brazil OFDA) Institutions" que a doc referencia mas não retornei conteúdo via WebFetch (página parece exigir contexto autenticado). Lista pública específica de Itaú/Bradesco/Nubank/etc não confirmada nominalmente nessa rodada — ambíguo. Fonte: <https://developers.belvo.com/products/aggregation_brazil/aggregation-brazil-introduction>.
- Belvo lançou "Open Finance solution for regulated players in Brazil" (2022), explicitamente vendendo pra S1-S5, sociedades de crédito e instituições de pagamento. Para players não-regulados, diz que oferece também ("regulated and non-regulated sources"), mas o pitch principal e a estrutura comercial é claramente B2B regulado. Fonte: <https://belvo.com/blog/belvo-launches-official-open-finance-solution-regulated-institutions-brazil/>.

### Sandbox e onboarding
- Sandbox grátis com dados dummy. Refresh no dia 1 de cada mês (deleta tudo). Pagination 10/pág no sandbox vs 100 em produção. Fonte: <https://developers.belvo.com/developer_resources/resources-sandbox>.
- "test live data — up to 25 real data links" no Test plan, mas o sandbox doc explicitamente diz que "Banking Brazil" é "externally managed", então qualidade e uptime não garantidos. Fonte: idem.
- Não diz publicamente se exige CNPJ pra signup. Pelo perfil enterprise da empresa e foco em players regulados, é razoável esperar processo comercial (contato com sales) antes de produção real. Ambíguo.

### Tipos de dado
- Owner (CPF/CNPJ, contato), accounts (saldo, overdraft, loan, cartão), transações, faturas de cartão, balances detalhados (disponível/bloqueado/investido), investimentos (posições, ISIN, valuations), transações de investimento. Fonte: <https://developers.belvo.com/products/aggregation_brazil/aggregation-brazil-introduction>.
- Pix via Open Finance: produto separado "Payment Initiation Brazil". Fonte: <https://belvo.com/products/payment-initiation/> e guia <https://developers.belvo.com/pt-br/products/payments_brazil/payments-brazil-pix-via-open-finance-api-guide>.

### OAuth e consent
- "Belvo Hosted Widget" guia o usuário, redireciona pro banco, volta. Puxa automaticamente 12 meses de histórico após consent. Fonte: <https://developers.belvo.com/products/aggregation_brazil/aggregation-brazil-introduction>.
- Consents user-managed via "My Belvo Portal" (<https://developers.belvo.com/products/aggregation_brazil/aggregation-brazil-mybelvoportal>). Belvo manda webhook quando consent expira. Renovação manual pelo portal.
- Deletar link revoga o consent automaticamente.

### SDK e docs
- Doc bem estruturada, OpenAPI completo (<https://developers.belvo.com/apis/belvoopenapispec>).
- Não confirmei SDK Node oficial nessa rodada (a doc não destacou; existem libs em Python/PHP historicamente). Ambíguo.

---

## Klavi

- Site: <https://klavi.ai/>

### Pricing
- Não disponível publicamente. Site não tem página de pricing. Fonte: <https://klavi.ai/>.

### Cobertura
- Não lista bancos suportados publicamente.
- Detentora da licença regulada via "Klavi Instituição de Pagamento e Gestão de Dados LTDA" (CNPJ 44.459.799/0001-54). Fonte: <https://klavi.ai/> (rodapé) e <https://startups.com.br/negocios/fintech/klavi-agora-tem-a-chave-do-open-finance-regulado/>.
- Foco da empresa: inteligência de crédito + categorização (cita "10bi+ transações processadas, 99%+ categorizadas"). Posicionamento B2B pesado, voltado a fintechs e instituições financeiras. Fonte: <https://klavi.ai/>.

### Sandbox / onboarding
- Não há sandbox público ou self-service aparente. É "fale com a gente". Fonte: <https://klavi.ai/>.

### Tipos de dado
- Cita transações categorizadas, comportamento do consumidor, "Open Finance + Pix", crédito. Detalhamento técnico não público. Ambíguo. Fonte: <https://klavi.ai/>.

### Conclusão Klavi
Não é viável pra projeto pessoal de baixo volume. Sem pricing público, sem sandbox self-service, com perfil de cliente claramente enterprise. Descartada.

---

## Iniciador

- Site: <https://iniciador.com.br/>

### Pricing
- Não disponível publicamente. Fonte: <https://iniciador.com.br/>.

### Cobertura
- Claim: "150 instituições", "1 bilhão de contas". Sem lista nominal pública. Ambíguo. Fonte: <https://iniciador.com.br/>.

### Modelo regulatório
- Iniciador detém licença própria de Instituição de Pagamento (CNPJ 44.471.172/0001-19). Suporta tanto plataformas reguladas quanto não reguladas — modelo piggyback explícito. Fonte: <https://iniciador.com.br/>.

### Sandbox e onboarding
- Tem demos live em produção: portal de teste de pagamento e portal de teste de compartilhamento de dados (<https://data.app.iniciador.com.br/run-test>). Fonte: <https://iniciador.com.br/>.
- Sem self-service de cadastro/sandbox aparente. Pricing via comercial.

### Tipos de dado e produto
- Foco principal histórico: Iniciação de Transação de Pagamento (ITP) com Pix com aprovação direta no app bancário. Recentemente adicionou "Data Connect" e "Cadastro Expresso" (puxar dados via portabilidade). Fonte: <https://iniciador.com.br/>.

### SDK
- "SDKs White Label & Guias de UX" mencionados, sem indicação clara de SDK Node público. Ambíguo. Fonte: <https://iniciador.com.br/>.

### Conclusão Iniciador
Forte em pagamentos (Pix), só agora entrando em agregação de dados. Sem pricing público, sem sandbox self-service. Pra projeto pessoal de leitura de dados não compensa o atrito.

---

## Síntese final

### Recomendação para projeto pessoal de baixo volume

**Use o "Meu Pluggy" enquanto durar como sandbox de aprendizado, e plante a expectativa de que produção real vai custar R$ 2.500/mês ou exigir uma negociação caso-a-caso.**

Detalhamento:
- O caso de uso "5-10 contas pessoais, 1k transações/mês, agente conversacional não comercial" é exatamente o que um trial Pluggy de 14 dias cobre confortavelmente (limite de 20 contas conectadas). Fonte: <https://www.pluggy.ai/pricing>.
- Depois do trial, há três rotas, todas com problemas:
  1. Plano Basic Pluggy (R$ 2.500/mês). Inviável pra hobby. Fonte: <https://www.pluggy.ai/pricing>.
  2. "Meu Pluggy" como ferramenta de pessoa física (free) + tentar acessar os dados via algum mecanismo de compartilhamento. Esse caminho é cinza: o produto é desenhado pra usuário final, não pra agente programático puxar dados via API. Funciona enquanto o trial dev estiver ativo (fonte: <https://github.com/andreroggeri/pynubank/discussions/431>) e depois congela edição.
  3. Belvo Test (US$ 0) com até 25 real data links — único free tier público com dados reais. Fonte: <https://belvo.com/plans-and-pricing/>. Caveat: sandbox Banking Brazil é "externally managed" sem garantia de uptime (<https://developers.belvo.com/developer_resources/resources-sandbox>) e o foco comercial da Belvo é S1-S5 regulado, então sustentar uso pessoal a longo prazo é incerto.
- Em todos os casos, plugar Open Finance num projeto pessoal de baixo volume é caro pro retorno. Para Boop, faz mais sentido atrasar a integração até ter um caso de uso comercial ou aceitar o limite do Meu Pluggy/Belvo Test e tratar como "best effort, pode quebrar".

### Estimativa de custo mensal (5-10 contas, ~1k tx/mês)

| Provider | Plano viável | Custo mensal | Caveat |
|---|---|---|---|
| Pluggy | Trial 14 dias | R$ 0 | Acaba em 14 dias. <https://www.pluggy.ai/pricing> |
| Pluggy | Basic | R$ 2.500/mês | Único plano público pago. <https://www.pluggy.ai/pricing> |
| Pluggy | Meu Pluggy | R$ 0 (consumer) | Não é API programática pra terceiros, é ferramenta de usuário. <https://meu.pluggy.ai/> |
| Belvo | Test | US$ 0 (~R$ 0) | "Up to 25 real data links". Sandbox Brazil sem SLA. <https://belvo.com/plans-and-pricing/> |
| Belvo | Launch | US$ 1.000/mês (~R$ 5.500) | Mensalidade fixa. Foco enterprise. <https://belvo.com/plans-and-pricing/> |
| Klavi | — | sem pricing público | Não atende dev solo. <https://klavi.ai/> |
| Iniciador | — | sem pricing público | Foco em pagamentos. <https://iniciador.com.br/> |

Realista: **R$ 0 a R$ 2.500/mês**, dependendo se você consegue se virar no trial/freemium ou se precisa do plano Basic Pluggy. Não há provider com modelo pay-per-use barato pra hobby.

### Riscos regulatórios pra dev solo

- **Autorização Bacen**: você não precisa, desde que entre via agregador regulado (Pluggy é ITP autorizada — Resolução BCB nº 80/2021, CNPJ 37.943.755/0001-30; Iniciador é IP regulada; Belvo segue guidelines BC mas o status próprio como participante não está cristalino na fonte pública que verifiquei). Fontes: <https://www.pluggy.ai/security> e <https://www.pluggy.ai/legal>; <https://iniciador.com.br/>; <https://belvo.com/blog/belvo-launches-official-open-finance-solution-regulated-institutions-brazil/>.
- **CNPJ próprio**: Pluggy diz explicitamente que o serviço pode ser usado por pessoa física (<https://meu.pluggy.ai/>); Belvo, Klavi e Iniciador são silenciosos publicamente — onboarding self-service deles parece desenhado pra empresas, mas não há proibição explícita ao PF. Esperado: pra produção paga, vão pedir CNPJ.
- **DPO**: a LGPD exige DPO formalmente para "controladores" de dados pessoais. Pra um agente pessoal que só processa seus próprios dados (você é o titular e o operador único), o requisito de DPO não se aplica de forma prática — você não está tratando dados de terceiros. Se Boop virar produto com usuários reais, você passa a ser controlador e aí precisa de DPO + política de privacidade + canal LGPD. Fonte regulatória geral: Lei 13.709/2018 art. 41. Pluggy expõe DPO próprio (<dpo@pluggy.ai>) cobrindo o lado deles. Fonte: <https://www.pluggy.ai/security>.
- **Token e consent**: tudo gerenciado pelo agregador. Você precisa lidar com o ciclo de re-consent (12 meses ou indeterminado, dependendo do que o usuário autoriza no banco). Fonte: <https://agenciagov.ebc.com.br/noticias/202310/bc-simplifica-renovacao-de-consentimentos-no-open-finance-e-amplia-prazo-de-validade-do-compartilhamento>.

### Pontos onde a pesquisa esbarrou em info opaca

- Lista nominal de bancos suportados pela Belvo no Brasil (Itaú/Bradesco/Nubank/etc). A doc menciona uma página dedicada que não retornou conteúdo via WebFetch.
- Cobertura nominal Open Finance regulada da Pluggy (Nubank, C6 explícitos).
- Pricing real Pluggy Custom, Belvo Growth, Klavi (qualquer coisa), Iniciador (qualquer coisa) — todos atrás de "fale com vendas".
- SDK Node oficial Belvo (não confirmado).
- Status atual do "Freemium" Pluggy de 2021 — não aparece mais na página de pricing 2026, pode ter sido descontinuado ou virado o "Meu Pluggy".

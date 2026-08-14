# Conduz WhatsApp Bridge

Serviço separado (roda 24/7) que conecta um número de WhatsApp igual o **WhatsApp Web** — sem usar a API oficial da Meta. Serve pra números que já estão em uso no app comum do WhatsApp Business e não podem ser migrados pra API oficial.

⚠️ **Isso usa uma biblioteca não-oficial ([Baileys](https://github.com/WhiskeySockets/Baileys)) que imita o protocolo do WhatsApp Web.** Viola os Termos de Uso do WhatsApp e existe risco de banimento do número. Ver a conversa com o Conduz CRM pra mais contexto sobre esse risco.

## Como funciona

- Guarda a sessão (equivalente a estar "logado" no WhatsApp Web) direto no mesmo banco Supabase do CRM, na tabela `whatsapp_bridge_sessao` — assim sobrevive a reinícios do servidor sem precisar escanear o QR de novo toda hora.
- Ao conectar, escreve o QR code (e o status de conexão) na tabela `whatsapp_bridge_status`, que o Conduz CRM lê e mostra numa tela própria — você nunca precisa abrir esse serviço diretamente.
- Mensagens recebidas (e enviadas pelo celular, já que o app continua funcionando normalmente) são gravadas em `whatsapp_conversas` / `whatsapp_mensagens` com `canal = 'nao_oficial'`.
- Expõe um endpoint HTTP (`POST /enviar`) que o CRM chama pra mandar mensagens por esse canal.

## Deploy no Render

1. Crie um **Web Service** novo no [Render](https://dashboard.render.com), com este repositório/pasta.
2. **Build Command:** `npm install && npm run build`
3. **Start Command:** `npm start`
4. Variáveis de ambiente (mesmas do `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `BRIDGE_API_KEY`
5. Depois do primeiro deploy, abra a tela **Configurações > WhatsApp** no Conduz CRM — o QR code deve aparecer lá pra você escanear com o celular (WhatsApp > Aparelhos conectados > Conectar um aparelho).

## Rodar localmente

```bash
cp .env.example .env
npm install
npm run dev
```

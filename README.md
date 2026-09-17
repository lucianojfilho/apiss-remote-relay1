# apiss-remote-relay

Painel web para controlar o APISS pelo celular, de qualquer lugar. O APISS se
conecta a este serviço só para fora (nenhuma porta é aberta no seu
computador); o celular fala só com este serviço.

## Deploy no Render.com (gratuito, sem cartão de crédito)

1. Crie uma conta no GitHub (https://github.com) se ainda não tiver uma, e
   suba esta pasta (`apiss-remote-relay`) como um repositório novo.
2. Crie uma conta no Render (https://render.com) — pode entrar direto com a
   conta do GitHub.
3. No painel do Render, clique em **New +** → **Web Service**, e conecte o
   repositório que você acabou de subir.
4. Configurações do serviço:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Abra o APISS no seu computador, vá em **Outras ferramentas → Controle
   remoto** e copie o valor do campo **"Segredo do agente"** (o APISS já
   gera esse valor sozinho, na primeira vez que a aba é aberta).
6. De volta no Render, em **Environment Variables**, adicione:
   - `AGENT_SECRET` = cole exatamente o valor copiado do APISS.
7. Clique em **Create Web Service** e aguarde o deploy (alguns minutos).
8. Quando concluir, o Render mostra uma URL pública, algo como
   `https://apiss-remote-relay.onrender.com`. Copie essa URL.

## Configurando o APISS

No APISS, na mesma aba **Controle remoto**, cole a URL do Render no campo de
endereço e clique em Salvar. Depois clique em "Gerar código de pareamento" e
digite esse código no celular, na mesma URL.

## Aviso sobre o plano gratuito

O plano gratuito do Render "dorme" o serviço depois de ~15 minutos sem uso e
demora alguns segundos para acordar na próxima visita — normal, sem
configuração extra. O APISS reconecta sozinho quando isso acontece.

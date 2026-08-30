# Coup Online

Versão multiplayer do jogo de blefe **Coup**, para 2 a 6 jogadores, jogável pelo navegador com amigos à distância.

## Rodar localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000` no navegador. Para testar sozinho, abra em duas abas (ou uma aba normal + uma anônima).

## Como jogar

1. Um jogador clica em **Criar Sala** e recebe um código de 4 letras.
2. Os outros jogadores clicam em **Entrar em Sala** e digitam esse código.
3. Quando todos entrarem (mínimo 2, máximo 6), o anfitrião clica em **Iniciar Partida**.
4. Se alguém atualizar a página ou cair a conexão, basta recarregar a mesma aba — o jogo lembra automaticamente do seu lugar na sala (via `sessionStorage`, isolado por aba: abrir várias abas no mesmo navegador para jogar contra si mesmo continua funcionando sem misturar as identidades).

## Colocar no ar para jogar com um amigo à distância (Render, grátis)

1. **Criar um repositório no GitHub** com este projeto:
   ```bash
   git init
   git add .
   git commit -m "Coup online"
   ```
   Depois crie um repositório vazio em https://github.com/new e siga as instruções que o GitHub mostra para enviar (`git remote add origin ...` + `git push`).

2. **Criar a conta no Render**: acesse https://render.com e crie uma conta gratuita (dá para entrar direto com a conta do GitHub).

3. **Criar o serviço**:
   - No painel do Render, clique em **New +** → **Web Service**.
   - Conecte o repositório do GitHub que você acabou de criar.
   - Configure:
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Instance Type**: Free
   - Clique em **Create Web Service**.

4. Depois de alguns minutos, o Render mostra uma URL pública (algo como `https://coup-online.onrender.com`). É esse link que você compartilha com seu amigo — cada um abre em seu próprio dispositivo.

> Nota: no plano gratuito do Render, o servidor "dorme" depois de um tempo sem uso e demora ~30s para acordar no próximo acesso. Isso é normal e não afeta o jogo depois que a partida começa.

## Estrutura do projeto

- `server.js` — servidor Express + Socket.IO.
- `src/game/` — regras do jogo (baralho, ações, motor de estado), sem dependência de rede.
- `src/RoomManager.js` — salas e jogadores.
- `public/` — frontend (HTML/CSS/JS puro).

(() => {
  'use strict';

  const ICONS = {
    duke: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 8l4 3 5-6 5 6 4-3-2 10H5L3 8z"/><path d="M5 21h14"/></svg>',
    assassin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v12"/><path d="M9 6l3-4 3 4"/><path d="M7.5 14h9l-2 3.5h-5L7.5 14z"/><path d="M12 17.5V22"/></svg>',
    captain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M12 7v13"/><path d="M6 12H2a10 10 0 0020 0h-4"/><path d="M8 12h8"/></svg>',
    ambassador: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13"/><path d="M14 4l3 4-3 4"/><path d="M20 16H7"/><path d="M10 12l-3 4 3 4"/></svg>',
    contessa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    inquisitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><path d="M20 20l-5.5-5.5"/></svg>',
  };

  const CHAR_META = {
    duke: {
      name: 'Duque', light: 'var(--c-duke)', dark: 'var(--c-duke-dark)',
      desc: 'Ação Taxar: cobra 3 moedas do tesouro, sem custo. Bloqueio: impede a Ajuda Externa de qualquer jogador.',
    },
    assassin: {
      name: 'Assassino', light: 'var(--c-assassin)', dark: 'var(--c-assassin-dark)',
      desc: 'Ação Assassinar: por 3 moedas, elimina uma carta de influência de um alvo. Só é bloqueada por quem alegar Condessa.',
    },
    captain: {
      name: 'Capitão', light: 'var(--c-captain)', dark: 'var(--c-captain-dark)',
      desc: 'Ação Extorquir: rouba 2 moedas (ou o que restar) de um alvo, sem custo. Bloqueio: impede uma Extorsão sofrida.',
    },
    ambassador: {
      name: 'Embaixador', light: 'var(--c-ambassador)', dark: 'var(--c-ambassador-dark)',
      desc: 'Ação Trocar: compra 2 cartas do baralho e escolhe quais manter, descartando o resto. Bloqueio: impede uma Extorsão sofrida.',
    },
    contessa: {
      name: 'Condessa', light: 'var(--c-contessa)', dark: 'var(--c-contessa-dark)',
      desc: 'Sem ação própria. Bloqueio: impede um Assassinato sofrido.',
    },
    inquisitor: {
      name: 'Inquisidor', light: 'var(--c-inquisitor)', dark: 'var(--c-inquisitor-dark)',
      desc: 'Ação Trocar: troca 1 carta com o baralho. Ação Inquirir: examina a carta oculta de um alvo, podendo forçar a troca dela. Bloqueio: impede uma Extorsão sofrida.',
    },
  };

  const MODE_CHARACTERS = {
    classic: ['duke', 'assassin', 'captain', 'ambassador', 'contessa'],
    reformation: ['duke', 'assassin', 'captain', 'inquisitor', 'contessa'],
  };

  const PLAYER_LOG_COLORS = ['#6fb3ff', '#ff9a6f', '#7be08a', '#e08ae0', '#ffd76f', '#8ad9d0'];

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  const ACTIONS_CLIENT = {
    income: { label: 'Renda', cost: 0, sub: '+1 moeda', requiresTarget: false },
    foreign_aid: { label: 'Ajuda Externa', cost: 0, sub: '+2 moedas', requiresTarget: false },
    coup: { label: 'Golpe de Estado', cost: 7, sub: 'Elimina 1 carta', requiresTarget: true, danger: true },
    tax: { label: 'Taxar', cost: 0, sub: 'Duque · +3 moedas', requiresTarget: false, character: 'duke' },
    assassinate: { label: 'Assassinar', cost: 3, sub: 'Assassino · elimina 1 carta', requiresTarget: true, character: 'assassin', danger: true },
    steal: { label: 'Extorquir', cost: 0, sub: 'Capitão · rouba 2 moedas', requiresTarget: true, character: 'captain' },
    exchange: { label: 'Trocar', cost: 0, sub: 'Embaixador · troca cartas', requiresTarget: false, character: 'ambassador' },
    examine: { label: 'Inquirir', cost: 0, sub: 'Inquisidor · investiga carta', requiresTarget: true, character: 'inquisitor' },
  };

  // "Trocar" is claimed under a different character depending on the room's
  // mode, and "Inquirir" only exists in reformation mode at all.
  function actionsForMode(mode) {
    const list = { ...ACTIONS_CLIENT };
    if (mode === 'reformation') {
      list.exchange = { ...list.exchange, sub: 'Inquisidor · troca cartas', character: 'inquisitor' };
    } else {
      delete list.examine;
    }
    return list;
  }

  function actionBlockedBy(actionName, mode) {
    const map = {
      foreign_aid: ['duke'],
      assassinate: ['contessa'],
      steal: ['captain', mode === 'reformation' ? 'inquisitor' : 'ambassador'],
    };
    return map[actionName] || [];
  }

  const socket = io();

  const el = (id) => document.getElementById(id);
  const screenLobby = el('screen-lobby');
  const screenGame = el('screen-game');
  const lobbyForms = el('lobby-forms');
  const waitingRoom = el('waiting-room');
  const lobbyError = el('lobby-error');
  const modalOverlay = el('modal-overlay');
  const modalContent = el('modal-content');
  const toastEl = el('toast');

  let myToken = sessionStorage.getItem('coup_token') || null;
  let myRoomCode = sessionStorage.getItem('coup_room') || null;
  let lastLobbyState = null;
  let lastGameState = null;
  let activeModalKey = null;
  let peekedKey = null;
  // Modal "Aguarde" que o jogador fechou: é só informativo, então não volta
  // a abrir nem acende o botão Responder (quem não deve resposta não responde).
  let dismissedStatusKey = null;
  let exchangeSelection = [];
  let toastTimer = null;
  let wasKicked = false;

  // ---------- helpers ----------

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
  }

  function saveIdentity(roomCode, token) {
    myToken = token;
    myRoomCode = roomCode;
    sessionStorage.setItem('coup_token', token);
    sessionStorage.setItem('coup_room', roomCode);
  }

  function clearIdentity() {
    sessionStorage.removeItem('coup_token');
    sessionStorage.removeItem('coup_room');
  }

  function characterCard(character, { revealed, selected } = {}) {
    const meta = CHAR_META[character];
    const cls = ['hand-card'];
    if (revealed) cls.push('is-revealed');
    if (selected) cls.push('selected');
    return `<div class="${cls.join(' ')}" style="--card-color-light:${meta.light};--card-color-dark:${meta.dark}" data-tooltip="${escapeHtml(meta.desc)}">
      <div class="hc-icon" style="color:#fff">${ICONS[character]}</div>
      <div class="hc-name">${meta.name}</div>
    </div>`;
  }

  function choiceCardHtml(character, index) {
    const meta = CHAR_META[character];
    return `<button class="choice-card" data-index="${index}" style="--card-color-light:${meta.light};--card-color-dark:${meta.dark}">
      <div class="hc-icon">${ICONS[character]}</div>
      <div>${meta.name}</div>
    </button>`;
  }

  function playerName(id) {
    const state = lastGameState;
    if (!state) return '';
    const p = state.players.find((pl) => pl.id === id);
    return p ? escapeHtml(p.name) : '';
  }

  function playerLogColor(playerId, state) {
    const idx = state.players.findIndex((p) => p.id === playerId);
    return PLAYER_LOG_COLORS[idx % PLAYER_LOG_COLORS.length];
  }

  function closeModal() {
    modalOverlay.hidden = true;
    modalContent.innerHTML = '';
    activeModalKey = null;
  }

  function openModal(html, { wide } = {}) {
    modalContent.innerHTML = html;
    modalContent.classList.toggle('wide', !!wide);
    modalOverlay.hidden = false;
    tickCountdowns();
  }

  // Closes the current modal without treating it as a response, so the
  // player can look at the board. The pending decision is remembered by
  // `peekedKey` and stays closed until they explicitly reopen it.
  function peekModal(key) {
    peekedKey = key;
    closeModal();
    updateRespondButton();
  }

  function updateRespondButton() {
    el('btn-respond').hidden = !peekedKey;
  }

  el('btn-respond').addEventListener('click', () => {
    if (!peekedKey || !lastGameState) return;
    peekedKey = null;
    activeModalKey = null;
    updateRespondButton();
    syncModal(lastGameState, me(lastGameState));
  });

  function countdownHtml(state) {
    if (!state.respondBy) return '';
    return `<p class="modal-countdown" data-respond-by="${state.respondBy}"></p>`;
  }

  function tickCountdowns() {
    document.querySelectorAll('.modal-countdown[data-respond-by]').forEach((cd) => {
      const remaining = Math.max(0, Math.ceil((Number(cd.dataset.respondBy) - Date.now()) / 1000));
      cd.textContent = `Tempo restante: ${remaining}s`;
    });
  }
  setInterval(tickCountdowns, 1000);

  // ---------- lobby ----------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      el(`form-${tab.dataset.tab}`).classList.add('active');
    });
  });

  function wireOptionGroup(groupId) {
    const group = el(groupId);
    group.querySelectorAll('.option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }
  wireOptionGroup('mode-group');
  wireOptionGroup('timeout-group');

  function selectedOption(groupId) {
    const active = el(groupId).querySelector('.option-btn.active');
    return active ? active.dataset.value : '';
  }

  el('form-create').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    const name = el('create-name').value.trim();
    const mode = selectedOption('mode-group');
    const responseTimeout = selectedOption('timeout-group') || null;
    lobbyError.hidden = true;
    socket.emit('create_room', { playerName: name, mode, responseTimeout }, (res) => {
      btn.disabled = false;
      if (!res.ok) { lobbyError.textContent = res.error; lobbyError.hidden = false; return; }
      saveIdentity(res.roomCode, res.token);
    });
  });

  el('form-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    const name = el('join-name').value.trim();
    const code = el('join-code').value.trim().toUpperCase();
    lobbyError.hidden = true;
    socket.emit('join_room', { playerName: name, roomCode: code }, (res) => {
      btn.disabled = false;
      if (!res.ok) { lobbyError.textContent = res.error; lobbyError.hidden = false; return; }
      saveIdentity(res.roomCode, res.token);
    });
  });

  el('btn-start').addEventListener('click', () => {
    if (el('btn-start').disabled) return;
    el('btn-start').disabled = true;
    socket.emit('start_game');
  });

  socket.on('connect', () => {
    if (myToken && myRoomCode) {
      socket.emit('rejoin', { roomCode: myRoomCode, token: myToken }, (res) => {
        if (!res || !res.ok) {
          clearIdentity();
          myToken = null;
          myRoomCode = null;
          // Sem isso a tela antiga da partida continua visível, mas o servidor
          // (ex.: reiniciado num deploy) já não conhece a sala e ignora tudo.
          if (!screenGame.hidden) {
            openModal(`
              <h2>Partida Encerrada</h2>
              <p class="desc">A conexão com a partida foi perdida (o servidor pode ter reiniciado). Crie uma nova sala para continuar jogando.</p>
              <div class="modal-actions"><button class="btn btn-primary" id="btn-lost-ok">Voltar ao início</button></div>
            `);
            activeModalKey = 'session-lost';
            modalContent.querySelector('#btn-lost-ok').addEventListener('click', () => location.reload());
          }
        }
      });
    }
  });

  socket.on('error_message', (message) => {
    showToast(message);
    el('btn-start').disabled = false;
  });

  socket.on('kicked', () => {
    wasKicked = true;
    clearIdentity();
    openModal(`
      <h2>Removido da Sala</h2>
      <p class="desc">O anfitrião removeu você da sala.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="btn-kicked-ok">OK</button></div>
    `);
    modalContent.querySelector('#btn-kicked-ok').addEventListener('click', () => location.reload());
  });

  socket.on('lobby_state', (state) => {
    if (wasKicked) return;
    lastGameState = null;
    lastLobbyState = state;
    screenLobby.hidden = false;
    screenGame.hidden = true;
    lobbyForms.hidden = true;
    waitingRoom.hidden = false;
    renderLobby(state);
  });

  function confirmKick(token, name, midGame) {
    openModal(`
      <h2>Remover Jogador</h2>
      <p class="desc">Remover <strong>${name}</strong> da sala${midGame ? ' e da partida' : ''}? ${midGame ? 'Todas as cartas dele serão reveladas e ele sairá da partida. ' : ''}Isso não pode ser desfeito.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-kick-cancel">Cancelar</button>
        <button class="btn btn-danger" id="btn-kick-confirm">Remover</button>
      </div>
    `);
    activeModalKey = 'kick-confirm';
    modalContent.querySelector('#btn-kick-cancel').addEventListener('click', closeModal);
    modalContent.querySelector('#btn-kick-confirm').addEventListener('click', () => {
      socket.emit('kick_player', { targetToken: token });
      closeModal();
    });
  }

  function renderLobby(state) {
    el('room-code-display').textContent = state.code;
    const isHost = state.you === state.hostToken;
    const modeLabel = state.mode === 'reformation' ? 'Reformation (Inquisidor)' : 'Clássico (Embaixador)';
    const timeoutLabel = state.responseTimeoutMs ? `${state.responseTimeoutMs / 1000}s por decisão` : 'Sem limite de tempo';
    el('room-config').textContent = `${modeLabel} · ${timeoutLabel}`;

    el('lobby-players').innerHTML = state.players.map((p) => `
      <li>
        <span class="dot ${p.connected ? '' : 'offline'}"></span>
        <span>${escapeHtml(p.name)}${p.token === state.you ? ' (você)' : ''}</span>
        ${p.token === state.hostToken ? '<span class="host-tag">Anfitrião</span>' : ''}
        ${isHost && p.token !== state.you ? `<button class="btn-kick" data-token="${p.token}" data-name="${escapeHtml(p.name)}">Remover</button>` : ''}
      </li>
    `).join('');
    el('lobby-players').querySelectorAll('.btn-kick').forEach((btn) => {
      btn.addEventListener('click', () => confirmKick(btn.dataset.token, btn.dataset.name, false));
    });

    const startBtn = el('btn-start');
    const hint = el('waiting-hint');
    if (isHost) {
      startBtn.hidden = false;
      startBtn.disabled = state.players.length < 2;
      hint.textContent = state.players.length < 2
        ? 'Aguardando mais jogadores (mínimo 2)…'
        : 'Quando todos estiverem prontos, inicie a partida.';
    } else {
      startBtn.hidden = true;
      hint.textContent = 'Aguardando o anfitrião iniciar a partida…';
    }
  }

  // ---------- game ----------

  socket.on('game_state', (state) => {
    if (wasKicked) return;
    lastLobbyState = null;
    lastGameState = state;
    screenLobby.hidden = true;
    screenGame.hidden = false;
    renderGame(state);
  });

  function me(state) {
    return state.players.find((p) => p.id === state.you);
  }

  function renderGame(state) {
    const myself = me(state);
    const turnPlayer = state.players.find((p) => p.id === state.turnPlayerId);

    el('turn-indicator').innerHTML = state.phase === 'game_over'
      ? ''
      : (state.turnPlayerId === state.you ? '<strong>É a sua vez</strong>' : `Vez de <strong>${turnPlayer ? escapeHtml(turnPlayer.name) : ''}</strong>`);

    el('btn-forfeit').hidden = state.phase === 'game_over' || !myself || !myself.alive;

    const isHost = state.you === state.hostToken;
    el('players-table').innerHTML = state.players.map((p) => {
      const cls = ['player-card'];
      if (p.id === state.turnPlayerId && state.phase !== 'game_over') cls.push('is-turn');
      if (p.id === state.you) cls.push('is-me');
      if (!p.alive) cls.push('is-dead');

      const cardsHtml = [
        ...p.revealedCards.map((c) => `<div class="mini-card revealed" style="--card-color:${CHAR_META[c].light}">${ICONS[c]}<span class="mini-card-name">${CHAR_META[c].name}</span></div>`),
        ...Array.from({ length: p.influenceCount }, () => `<div class="mini-card">?</div>`),
      ].join('') || '<span style="color:var(--text-dim);font-size:12px">eliminado</span>';

      const showKick = isHost && p.id !== state.you && p.alive && state.phase !== 'game_over';

      return `<div class="${cls.join(' ')}">
        <div class="player-name-row">
          <span class="dot ${p.connected ? '' : 'offline'}"></span>
          <span class="player-name">${escapeHtml(p.name)}${p.id === state.you ? ' (você)' : ''}</span>
          ${showKick ? `<button class="btn-kick" data-token="${p.id}" data-name="${escapeHtml(p.name)}">Remover</button>` : ''}
        </div>
        <div class="player-coins"><span class="coin-icon"></span> ${p.coins}</div>
        <div class="mini-cards">${cardsHtml}</div>
      </div>`;
    }).join('');
    el('players-table').querySelectorAll('.btn-kick').forEach((btn) => {
      btn.addEventListener('click', () => confirmKick(btn.dataset.token, btn.dataset.name, true));
    });

    if (myself && myself.cards) {
      el('my-cards').innerHTML = myself.cards.map((c) => characterCard(c.character, { revealed: c.revealed })).join('');
      el('my-coins').innerHTML = `<span class="coin-icon"></span> ${myself.coins}`;
    }

    renderActionBar(state, myself);
    renderLog(state);
    renderChat(state);
    syncModal(state, myself);
  }

  function colorizeLogText(text, state) {
    let html = escapeHtml(text);
    const named = state.players
      .map((p) => ({ id: p.id, name: escapeHtml(p.name) }))
      .filter((p) => p.name)
      .sort((a, b) => b.name.length - a.name.length);
    named.forEach(({ id, name }) => {
      const color = playerLogColor(id, state);
      const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(pattern, 'g'), `<span class="log-player" style="color:${color}">${name}</span>`);
    });
    return html;
  }

  function renderLog(state) {
    el('log-list').innerHTML = state.log.map((entry) => `<li>${colorizeLogText(entry.text, state)}</li>`).join('');
    const list = el('log-list');
    list.scrollTop = list.scrollHeight;
  }

  function renderChat(state) {
    const list = el('chat-list');
    list.innerHTML = (state.chat || []).map((m) => `
      <li><span class="log-player" style="color:${playerLogColor(m.token, state)}">${escapeHtml(m.name)}</span>: ${escapeHtml(m.text)}</li>
    `).join('');
    list.scrollTop = list.scrollHeight;
  }

  el('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text });
    input.value = '';
  });

  document.querySelectorAll('.log-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isChat = tab.dataset.tab === 'chat';
      el('log-list').hidden = isChat;
      el('chat-panel').hidden = !isChat;
    });
  });

  function renderActionBar(state, myself) {
    const bar = el('action-bar');
    if (state.phase === 'game_over') { bar.innerHTML = ''; return; }

    if (state.phase !== 'awaiting_action') {
      bar.innerHTML = '<span class="waiting-turn">Aguardando resolução da ação em andamento…</span>';
      return;
    }

    if (state.turnPlayerId !== state.you) {
      bar.innerHTML = `<span class="waiting-turn">Aguardando ${playerName(state.turnPlayerId)} jogar…</span>`;
      return;
    }

    const mustCoup = myself.coins >= 10;
    const actions = actionsForMode(state.mode);
    bar.innerHTML = Object.entries(actions).map(([key, a]) => {
      const disabled = myself.coins < a.cost || (mustCoup && key !== 'coup');
      return `<button class="action-btn ${a.danger ? 'danger' : ''}" data-action="${key}" ${disabled ? 'disabled' : ''}>
        ${a.label}${a.cost ? ` (${a.cost})` : ''}
        <small>${a.sub}</small>
      </button>`;
    }).join('');

    bar.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.action;
        const meta = actions[key];
        if (meta.requiresTarget) {
          openTargetPicker(state, key);
        } else {
          socket.emit('action', { action: key });
        }
      });
    });
  }

  function openTargetPicker(state, actionKey) {
    const meta = actionsForMode(state.mode)[actionKey];
    const targets = state.players.filter((p) => p.alive && p.id !== state.you);
    openModal(`
      <h2>${meta.label}</h2>
      <p class="desc">Escolha o alvo desta ação.</p>
      <div class="modal-choices">
        ${targets.map((t) => `<button class="choice-player" data-id="${t.id}">${escapeHtml(t.name)}</button>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="modal-cancel">Cancelar</button></div>
    `);
    modalContent.querySelectorAll('.choice-player').forEach((b) => {
      b.addEventListener('click', () => {
        socket.emit('action', { action: actionKey, targetId: b.dataset.id });
        closeModal();
      });
    });
    modalContent.querySelector('#modal-cancel').addEventListener('click', closeModal);
    activeModalKey = `target:${actionKey}`;
  }

  function actionLabel(name) {
    return (ACTIONS_CLIENT[name] && ACTIONS_CLIENT[name].label) || name;
  }

  function syncModal(state, myself) {
    if (state.phase === 'game_over') {
      const key = 'game_over';
      if (activeModalKey === key) return;
      activeModalKey = key;
      peekedKey = null;
      updateRespondButton();
      const winner = state.players.find((p) => p.id === state.winnerId);
      openModal(`
        <h2>Fim de Jogo</h2>
        <p class="winner-banner">${winner ? `${escapeHtml(winner.name)} venceu a partida!` : 'A partida terminou.'}</p>
        <div class="modal-actions" style="margin-top:18px">
          <button class="btn btn-primary" id="btn-rematch">Voltar ao início</button>
        </div>
      `);
      modalContent.querySelector('#btn-rematch').addEventListener('click', () => {
        clearIdentity();
        location.reload();
      });
      return;
    }

    const pending = state.pending;
    if (!pending) {
      peekedKey = null;
      updateRespondButton();
      if (activeModalKey && !activeModalKey.startsWith('target:') && activeModalKey !== 'forfeit-confirm' && activeModalKey !== 'kick-confirm') closeModal();
      return;
    }

    const actorName = playerName(pending.actorId);
    const targetName = pending.targetId ? playerName(pending.targetId) : null;
    const claimLabel = pending.claimedCharacter ? CHAR_META[pending.claimedCharacter].name : '';

    if (state.phase === 'challenge_action') {
      const key = `challenge_action:${pending.actorId}:${pending.action}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      const eligible = pending.eligibleIds.includes(state.you) && !pending.respondedIds.includes(state.you);
      if (!eligible) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        if (state.you === pending.actorId || pending.respondedIds.includes(state.you)) {
          showStatusModal(key, `${actorName} alega ser ${claimLabel} para usar ${actionLabel(pending.action)}${targetName ? ` em ${targetName}` : ''}.`, waitingListText(pending, state), state);
        }
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      openModal(`
        <h2>Desafio</h2>
        <p class="desc">${actorName} alega ser <strong>${claimLabel}</strong> para usar ${actionLabel(pending.action)}${targetName ? ` em ${targetName}` : ''}. Você acredita?</p>
        ${countdownHtml(state)}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-peek">Fechar</button>
          <button class="btn btn-ghost" id="btn-pass">Passar</button>
          <button class="btn btn-primary" id="btn-challenge">Desafiar</button>
        </div>
      `);
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      modalContent.querySelector('#btn-pass').addEventListener('click', () => { socket.emit('pass'); });
      modalContent.querySelector('#btn-challenge').addEventListener('click', () => { socket.emit('challenge'); });
      return;
    }

    if (state.phase === 'block_window') {
      const key = `block_window:${pending.actorId}:${pending.action}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      const eligible = pending.eligibleIds.includes(state.you) && !pending.respondedIds.includes(state.you);
      const blockChars = actionBlockedBy(pending.action, state.mode);
      if (!eligible) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${actorName} usou ${actionLabel(pending.action)}${targetName ? ` em ${targetName}` : ''}. Aguardando decisão sobre bloqueio…`, waitingListText(pending, state), state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      openModal(`
        <h2>Bloquear?</h2>
        <p class="desc">${actorName} usou ${actionLabel(pending.action)}${targetName ? ` em você` : ''}. Deseja bloquear alegando um personagem?</p>
        ${countdownHtml(state)}
        <div class="modal-choices">
          ${blockChars.map((c) => `<button class="choice-card" data-char="${c}" style="--card-color-light:${CHAR_META[c].light};--card-color-dark:${CHAR_META[c].dark}"><div class="hc-icon">${ICONS[c]}</div><div>${CHAR_META[c].name}</div></button>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-peek">Fechar</button>
          <button class="btn btn-ghost" id="btn-pass">Passar</button>
        </div>
      `);
      modalContent.querySelectorAll('.choice-card').forEach((b) => {
        b.addEventListener('click', () => { socket.emit('block', { character: b.dataset.char }); });
      });
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      modalContent.querySelector('#btn-pass').addEventListener('click', () => { socket.emit('pass'); });
      return;
    }

    if (state.phase === 'challenge_block') {
      const blockerName = playerName(pending.blockerId);
      const key = `challenge_block:${pending.blockerId}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      const eligible = pending.eligibleIds.includes(state.you) && !pending.respondedIds.includes(state.you);
      const claimBlock = CHAR_META[pending.blockCharacter].name;
      if (!eligible) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${blockerName} alega ser ${claimBlock} para bloquear a ação de ${actorName}.`, waitingListText(pending, state), state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      openModal(`
        <h2>Desafiar Bloqueio</h2>
        <p class="desc">${blockerName} alega ser <strong>${claimBlock}</strong> para bloquear ${actorName}. Você acredita?</p>
        ${countdownHtml(state)}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-peek">Fechar</button>
          <button class="btn btn-ghost" id="btn-pass">Passar</button>
          <button class="btn btn-primary" id="btn-challenge">Desafiar</button>
        </div>
      `);
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      modalContent.querySelector('#btn-pass').addEventListener('click', () => { socket.emit('pass'); });
      modalContent.querySelector('#btn-challenge').addEventListener('click', () => { socket.emit('challenge'); });
      return;
    }

    if (state.phase === 'awaiting_loss') {
      const key = `loss:${pending.awaitingLossPlayerId}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      if (pending.awaitingLossPlayerId !== state.you) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${playerName(pending.awaitingLossPlayerId)} precisa revelar uma influência…`, '', state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      const options = myself.cards.filter((c) => !c.revealed);
      openModal(`
        <h2>Perder Influência</h2>
        <p class="desc">Escolha qual carta revelar. Ela será perdida.</p>
        ${countdownHtml(state)}
        <div class="modal-choices">
          ${options.map((c) => choiceCardHtml(c.character, c.character)).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-ghost" id="btn-peek">Fechar</button></div>
      `);
      modalContent.querySelectorAll('.choice-card').forEach((b) => {
        b.addEventListener('click', () => { socket.emit('lose_influence', { character: b.dataset.index }); });
      });
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      return;
    }

    if (state.phase === 'exchange_choice') {
      const key = `exchange:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      if (pending.actorId !== state.you) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${actorName} está escolhendo cartas na troca…`, '', state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey !== key) {
        activeModalKey = key;
        exchangeSelection = [];
      }
      renderExchangeModal(pending, key, state);
      return;
    }

    if (state.phase === 'examine_reveal') {
      const key = `examine_reveal:${pending.targetId}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      if (pending.targetId !== state.you) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${playerName(pending.targetId)} está escolhendo uma carta para mostrar ao Inquisidor…`, '', state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      const options = myself.cards.filter((c) => !c.revealed);
      openModal(`
        <h2>Inquisidor</h2>
        <p class="desc">${actorName} está usando o Inquisidor para investigar você. Escolha qual carta mostrar (não será perdida, apenas revelada a ${actorName}).</p>
        ${countdownHtml(state)}
        <div class="modal-choices">
          ${options.map((c) => choiceCardHtml(c.character, c.character)).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-ghost" id="btn-peek">Fechar</button></div>
      `);
      modalContent.querySelectorAll('.choice-card').forEach((b) => {
        b.addEventListener('click', () => { socket.emit('choose_examine_card', { character: b.dataset.index }); });
      });
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      return;
    }

    if (state.phase === 'examine_decision') {
      const key = `examine_decision:${pending.actorId}:${state.logSeq}`;
      if (peekedKey && peekedKey !== key) { peekedKey = null; updateRespondButton(); }
      if (pending.actorId !== state.you) {
        if (peekedKey === key) { peekedKey = null; dismissedStatusKey = key; updateRespondButton(); }
        showStatusModal(key, `${actorName} está decidindo se troca a carta de ${targetName}…`, '', state);
        return;
      }
      if (peekedKey === key) { updateRespondButton(); return; }
      if (activeModalKey === key) return;
      activeModalKey = key;
      const shown = pending.examinedCharacter;
      openModal(`
        <h2>Decisão do Inquisidor</h2>
        <p class="desc">${targetName} mostrou: <strong>${shown ? CHAR_META[shown].name : '?'}</strong>. Deseja forçar a troca dessa carta com o baralho?</p>
        ${countdownHtml(state)}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-peek">Fechar</button>
          <button class="btn btn-ghost" id="btn-keep">Deixar</button>
          <button class="btn btn-primary" id="btn-swap">Trocar</button>
        </div>
      `);
      modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
      modalContent.querySelector('#btn-keep').addEventListener('click', () => { socket.emit('examine_decision', { swap: false }); });
      modalContent.querySelector('#btn-swap').addEventListener('click', () => { socket.emit('examine_decision', { swap: true }); });
      return;
    }
  }

  function waitingListText(pending, state) {
    const waitingFor = pending.eligibleIds.filter((id) => !pending.respondedIds.includes(id) && id !== state.you);
    if (waitingFor.length === 0) return '';
    return `Aguardando: ${waitingFor.map(playerName).join(', ')}`;
  }

  function showStatusModal(key, desc, status, state) {
    // Chave própria: após "Passar" a chave da fase é a mesma do modal de decisão,
    // então sem o sufixo o modal de decisão nunca seria substituído.
    const statusKey = `${key}:status`;
    if (dismissedStatusKey === key) return;
    if (activeModalKey === statusKey) {
      const statusEl = modalContent.querySelector('.modal-status');
      if (statusEl) statusEl.textContent = status;
      return;
    }
    activeModalKey = statusKey;
    openModal(`
      <h2>Aguarde</h2>
      <p class="desc">${desc}</p>
      <p class="modal-status">${status}</p>
      ${countdownHtml(state)}
      <div class="modal-actions" style="margin-top:14px"><button class="btn btn-ghost" id="btn-peek">Fechar</button></div>
    `);
    modalContent.querySelector('#btn-peek').addEventListener('click', () => {
      dismissedStatusKey = key;
      closeModal();
    });
  }

  function renderExchangeModal(pending, key, state) {
    const keepCount = pending.keepCount;
    openModal(`
      <h2>Trocar Cartas</h2>
      <p class="desc">Escolha ${keepCount} ${keepCount === 1 ? 'carta' : 'cartas'} para manter.</p>
      ${countdownHtml(state)}
      <div class="modal-choices" id="exchange-choices">
        ${pending.options.map((c, i) => choiceCardHtml(c, i)).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-peek">Fechar</button>
        <button class="btn btn-primary" id="btn-confirm-exchange" ${exchangeSelection.length === keepCount ? '' : 'disabled'}>Confirmar</button>
      </div>
    `);
    const cards = modalContent.querySelectorAll('.choice-card');
    cards.forEach((card) => {
      const idx = Number(card.dataset.index);
      if (exchangeSelection.includes(idx)) card.classList.add('selected');
      card.addEventListener('click', () => {
        const i = exchangeSelection.indexOf(idx);
        if (i >= 0) {
          exchangeSelection.splice(i, 1);
        } else if (exchangeSelection.length < keepCount) {
          exchangeSelection.push(idx);
        }
        renderExchangeModal(pending, key, state);
      });
    });
    modalContent.querySelector('#btn-peek').addEventListener('click', () => peekModal(key));
    const confirmBtn = modalContent.querySelector('#btn-confirm-exchange');
    confirmBtn.disabled = exchangeSelection.length !== keepCount;
    confirmBtn.addEventListener('click', () => {
      const keep = exchangeSelection.map((i) => pending.options[i]);
      socket.emit('exchange_choice', { keep });
    });
  }

  function showReferenceModal(mode) {
    activeModalKey = 'ref-cards';
    const chars = MODE_CHARACTERS[mode] || MODE_CHARACTERS.classic;
    openModal(`
      <h2>Personagens</h2>
      <p class="desc">Modo: ${mode === 'reformation' ? 'Reformation' : 'Clássico'}</p>
      <div class="reference-grid">
        ${chars.map((c) => `
          <div class="reference-card" style="--card-color-light:${CHAR_META[c].light};--card-color-dark:${CHAR_META[c].dark}">
            <div class="hc-icon">${ICONS[c]}</div>
            <div class="ref-name">${CHAR_META[c].name}</div>
            <div class="ref-desc">${escapeHtml(CHAR_META[c].desc)}</div>
          </div>
        `).join('')}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-ref">Fechar</button></div>
    `, { wide: true });
    modalContent.querySelector('#btn-close-ref').addEventListener('click', closeModal);
  }

  el('btn-view-cards').addEventListener('click', () => {
    if (!lastGameState) return;
    showReferenceModal(lastGameState.mode);
  });

  el('btn-toggle-log').addEventListener('click', () => {
    el('log-panel').classList.toggle('open');
  });

  el('btn-forfeit').addEventListener('click', () => {
    if (!lastGameState) return;
    const myself = me(lastGameState);
    if (!myself || !myself.alive) return;
    activeModalKey = 'forfeit-confirm';
    openModal(`
      <h2>Desistir da Partida</h2>
      <p class="desc">Suas cartas serão reveladas e você sairá definitivamente da partida. Isso não pode ser desfeito.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-forfeit-cancel">Cancelar</button>
        <button class="btn btn-danger" id="btn-forfeit-confirm">Desistir</button>
      </div>
    `);
    modalContent.querySelector('#btn-forfeit-cancel').addEventListener('click', closeModal);
    modalContent.querySelector('#btn-forfeit-confirm').addEventListener('click', () => {
      socket.emit('forfeit');
      closeModal();
    });
  });
})();

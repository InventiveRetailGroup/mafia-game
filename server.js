const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const games = {};

// ---------- Картинки ----------
const IMAGES_DIR = path.join(__dirname, 'public', 'images');
function findImage(role) {
  if (!fs.existsSync(IMAGES_DIR)) return null;
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'svg']) {
    const file = `${role}.${ext}`;
    if (fs.existsSync(path.join(IMAGES_DIR, file))) return `/images/${file}`;
  }
  return null;
}

// ---------- Конфиг ночи ----------
const NIGHT_ORDER = [
  { role: 'beauty',     seconds: 60, label: 'Красавчик' },
  { role: 'doctor',     seconds: 60, label: 'Доктор' },
  { role: 'mafia_don',  seconds: 60, label: 'Мафия' },
  { role: 'sheriff',    seconds: 60, label: 'Следователь' },
  { role: 'journalist', seconds: 60, label: 'Журналист' },
  { role: 'maniac',     seconds: 60, label: 'Маньяк' }
];

const MAX_DON_RECRUITS = 2;

// ---------- Утилиты ----------
function generateRoomId() {
  let id;
  do {
    id = nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (id.length < 4) id = id.padEnd(4, 'X');
  } while (games[id]);
  return id;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, alive: p.alive, connected: !!p.socketId, role: p.role };
}

function sendLobbyState(roomId) {
  const game = games[roomId];
  if (!game) return;
  io.to(game.hostSocketId).emit('lobbyState', {
    roomId,
    phase: game.phase,
    players: game.players.map(publicPlayer)
  });
}

function roleLabel(role) {
  return ({
    mafia: 'мафия', citizen: 'мирный', sheriff: 'следователь',
    doctor: 'доктор', maniac: 'маньяк', beauty: 'красавчик',
    journalist: 'журналист', don: 'дон', mayor: 'мер',
    bodyguard: 'телохранитель', rebel: 'мятежник'
  })[role] || role;
}

function roleNameRu(role) {
  return ({
    mafia: 'Мафия', citizen: 'Мирный житель', sheriff: 'Следователь',
    doctor: 'Доктор', maniac: 'Маньяк', beauty: 'Красавчик',
    journalist: 'Журналист', don: 'Дон', mayor: 'Мер',
    bodyguard: 'Телохранитель', rebel: 'Мятежник'
  })[role] || role;
}

function isSameTeam(a, b) {
  const mafiaTeam = ['mafia', 'don'];
  return mafiaTeam.includes(a.role) === mafiaTeam.includes(b.role);
}

function nameOf(game, id) {
  const p = game.players.find(pp => pp.id === id);
  return p ? p.name : '???';
}

// Особые роли, которых нельзя пригласить в мафию.
// Мятежника можно!
const UNRECRUITABLE = ['sheriff', 'doctor', 'maniac', 'beauty', 'journalist', 'mayor', 'bodyguard'];

function maxMafiaWithDon(n) {
  if (n <= 6) return 1;
  return 2;
}

function aliveMafiaOnlyCount(game) {
  return game.players.filter(p => p.alive && p.role === 'mafia').length;
}

function aliveMafiaCount(game) {
  return game.players.filter(p => p.alive && (p.role === 'mafia' || p.role === 'don')).length;
}

function currentMafiaLimit(game) {
  return maxMafiaWithDon(game.players.length);
}

function canDonInvite(game) {
  return game.recruitsLeft > 0 && aliveMafiaOnlyCount(game) < currentMafiaLimit(game);
}

// Мятежник считается мафией, если он "проснулся"
function isRebelMafia(player) {
  return player.role === 'rebel' && player.rebelAwakened;
}

function isMafiaTeamMember(player) {
  if (!player.alive) return false;
  if (player.role === 'mafia' || player.role === 'don') return true;
  if (player.role === 'rebel' && player.rebelAwakened) return true;
  return false;
}

// ---- Автобаланс ролей ----
function assignRoles(players) {
  const n = players.length;
  if (n < 4) return null;

  const fixed = players.filter(p => p.role);
  const free = players.filter(p => !p.role);

  const fixedCounts = {};
  fixed.forEach(p => { fixedCounts[p.role] = (fixedCounts[p.role] || 0) + 1; });

  const hasDon = fixedCounts.don > 0;
  const hasRebel = fixedCounts.rebel > 0;

  // Сколько мафий всего (с доном или без)
  // Если есть дон — мафий 0 автоматом (дон сам = 1 в команде)
  // Если есть мятежник — мафий 1 (мало игроков) или 2 (много)
  let autoMafiaCount = 0;
  if (!hasDon) {
    if (hasRebel) {
      autoMafiaCount = n <= 6 ? 1 : 2;
    } else {
      if (n <= 6) autoMafiaCount = 1;
      else if (n <= 9) autoMafiaCount = 2;
      else autoMafiaCount = 3;
    }
  }
  // Учитываем уже назначенных вручную мафий
  const fixedMafia = fixedCounts.mafia || 0;
  const needMafia = Math.max(0, autoMafiaCount - fixedMafia);

  // Особые роли (по 1 каждой) — сколько добавить автоматом
  // Список ролей, которые могут быть добавлены автоматически
  const autoSpecialPool = ['sheriff', 'doctor', 'bodyguard', 'mayor', 'maniac', 'beauty', 'journalist'];

  // Какие особые роли уже назначены вручную (и не будут добавлены повторно)
  const alreadySpecial = {};
  autoSpecialPool.forEach(r => { if (fixedCounts[r]) alreadySpecial[r] = true; });

  // Сколько свободных слотов для особых ролей
  // Целевое количество особых ролей в игре = max(2, floor(n/3)) — не слишком много
  let targetSpecialCount = Math.max(2, Math.floor(n / 3));
  // Ограничим до 4-5, чтобы не перегружать
  targetSpecialCount = Math.min(targetSpecialCount, 5);

  const fixedSpecialCount = autoSpecialPool.filter(r => fixedCounts[r]).length;
  let needSpecial = Math.max(0, targetSpecialCount - fixedSpecialCount);

  // Пул особых ролей — перемешанный
  const specialPool = autoSpecialPool.filter(r => !alreadySpecial[r]);
  for (let i = specialPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [specialPool[i], specialPool[j]] = [specialPool[j], specialPool[i]];
  }

  // Сколько свободных игроков останется для "свободных" ролей
  // Сначала посчитаем общее количество слотов
  // Свободные = free.length
  // Нужно разместить: needMafia + needSpecial + остальные мирные
  // Но если свободных меньше, чем нужно — сокращаем особые

  let assignMafia = Math.min(needMafia, free.length);
  let assignSpecial = Math.min(needSpecial, free.length - assignMafia);

  // Остаток — мирные
  const assignCitizens = free.length - assignMafia - assignSpecial;

  const pool = [];
  for (let i = 0; i < assignMafia; i++) pool.push('mafia');
  for (let i = 0; i < assignSpecial; i++) pool.push(specialPool[i]);
  for (let i = 0; i < assignCitizens; i++) pool.push('citizen');

  // Перемешиваем
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  free.forEach((p, i) => { p.role = pool[i] || 'citizen'; });
  players.forEach(p => {
    p.alive = true;
    p.rebelAwakened = false;
    // Телохранитель — 2 жизни
    p.bodyguardLives = p.role === 'bodyguard' ? 2 : 0;
  });

  return {
    mafiaCount: players.filter(p => p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)).length
  };
}

// ---------- Ночь ----------
function beginNight(roomId) {
  const game = games[roomId];
  if (!game) return;

  game.phase = 'night';
  game.day = (game.day || 0) + 1;

  if (!game.recruitsLeft) game.recruitsLeft = MAX_DON_RECRUITS;

  game.night = {
    actions: {},
    proposals: {},
    confirmed: {},
    blocked: [],
    lastDoctorTarget: game.lastDoctorTarget || null,
    doctorSelfUsed: game.doctorSelfUsed || false,
    currentStepIndex: -1,
    timerHandle: null,
    journal: [],
    donInviteFeedback: game.pendingDonFeedback || null
  };

  game.pendingDonFeedback = null;

  // Проверяем, есть ли мафия-команда (включая пробуждённого мятежника)
  const hasMafiaTeam = game.players.some(p => p.alive && (
    p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)
  ));

  game.night.steps = NIGHT_ORDER.filter(step => {
    if (step.role === 'mafia_don') return hasMafiaTeam;
    return game.players.some(p => p.alive && p.role === step.role);
  });

  game.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('phaseChanged', { phase: 'night', day: game.day });
  });
  io.to(game.hostSocketId).emit('phaseChanged', { phase: 'night', day: game.day });

  broadcastNightState(roomId);
  nextNightStep(roomId);
}

function nextNightStep(roomId) {
  const game = games[roomId];
  if (!game || game.phase !== 'night') return;

  if (game.night.timerHandle) {
    clearTimeout(game.night.timerHandle);
    game.night.timerHandle = null;
  }

  game.night.currentStepIndex++;
  const step = game.night.steps[game.night.currentStepIndex];

  if (!step) {
    finishNight(roomId);
    return;
  }

  broadcastNightState(roomId);
  const sec = step.seconds;
  game.night.timerHandle = setTimeout(() => nextNightStep(roomId), sec * 1000);
}

function getMafiaProposals(game) {
  const proposals = game.night.proposals.mafia_don || {};
  const result = {};
  game.players.forEach(p => {
    if (p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened))) {
      result[p.id] = proposals[p.id] || null;
    }
  });
  return result;
}

function getMafiaConfirmed(game) {
  const confirmed = game.night.confirmed.mafia_don || {};
  const result = {};
  game.players.forEach(p => {
    if (p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened))) {
      result[p.id] = !!confirmed[p.id];
    }
  });
  return result;
}

function broadcastNightState(roomId) {
  const game = games[roomId];
  if (!game) return;
  const step = game.night.steps[game.night.currentStepIndex] || null;

  const aliveMafiaTeam = game.players.filter(p =>
    p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened))
  );

  game.players.forEach(p => {
    if (!p.socketId) return;
    const isBlocked = game.night.blocked.includes(p.id);
    const inMafiaTeam = (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened));
    const yourTurn = !!(step && p.alive && !isBlocked && (
      (step.role === 'mafia_don' && inMafiaTeam) ||
      (step.role !== 'mafia_don' && p.role === step.role)
    ));

    let myProposal = null;
    let myConfirmed = false;
    if (inMafiaTeam && game.night.proposals.mafia_don) {
      myProposal = game.night.proposals.mafia_don[p.id] || null;
      myConfirmed = !!game.night.confirmed.mafia_don?.[p.id];
    }

    const doctorCanSelf = p.role === 'doctor' && p.alive && !isBlocked && !game.night.doctorSelfUsed;

    let blockedMafiaAlone = false;
    if (isBlocked && inMafiaTeam) {
      const others = aliveMafiaTeam.filter(x => x.id !== p.id);
      blockedMafiaAlone = others.length === 0;
    }

    let blockedCanPass = false;
    if (isBlocked && !inMafiaTeam) {
      const sameRoleAlive = game.players.filter(x => x.alive && x.role === p.role && x.id !== p.id && !game.night.blocked.includes(x.id));
      blockedCanPass = sameRoleAlive.length === 0;
    }

    io.to(p.socketId).emit('nightState', {
      day: game.day,
      stepRole: step ? step.role : null,
      stepLabel: step ? step.label : null,
      seconds: step ? step.seconds : 0,
      yourTurn,
      yourRole: (p.role === 'rebel' && p.rebelAwakened) ? 'mafia' : p.role,
      yourId: p.id,
      alive: p.alive,
      blocked: isBlocked,
      blockedMafiaAlone,
      blockedCanPass,
      doctorCanSelf,
      players: game.players.map(pp => ({
        id: pp.id, name: pp.name, alive: pp.alive, connected: !!pp.socketId,
        role: inMafiaTeam ? ((pp.role === 'mafia' || pp.role === 'don' || (pp.role === 'rebel' && pp.rebelAwakened)) ? 'mafia' : null) : null
      })),
      proposals: getMafiaProposals(game),
      confirmed: getMafiaConfirmed(game),
      myProposal,
      myConfirmed,
      recruitsLeft: game.recruitsLeft,
      canDonInvite: (p.role === 'don') ? canDonInvite(game) : false,
      donFeedback: (p.role === 'don') ? game.night.donInviteFeedback : null
    });
  });

  io.to(game.hostSocketId).emit('hostNightState', buildHostNightState(game));
}

function buildHostNightState(game) {
  return {
    day: game.day,
    stepIndex: game.night.currentStepIndex,
    totalSteps: game.night.steps.length,
    stepRole: game.night.steps[game.night.currentStepIndex]?.role || null,
    stepLabel: game.night.steps[game.night.currentStepIndex]?.label || null,
    players: game.players.map(p => ({
      id: p.id, name: p.name, role: p.role, alive: p.alive, connected: !!p.socketId,
      rebelAwakened: p.rebelAwakened || false
    })),
    actions: game.night.actions,
    proposals: game.night.proposals,
    blocked: game.night.blocked,
    journal: game.night.journal
  };
}

function allMafiaDonConfirmed(game) {
  const confirmed = game.night.confirmed.mafia_don || {};
  const players = game.players.filter(p =>
    p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)) && !game.night.blocked.includes(p.id)
  );
  return players.every(p => confirmed[p.id]);
}

function handleNightAction(roomId, playerId, payload) {
  const game = games[roomId];
  if (!game || game.phase !== 'night') return { ok: false, error: 'Не ночь' };

  const step = game.night.steps[game.night.currentStepIndex];
  if (!step) return { ok: false, error: 'Действий больше нет' };

  const player = game.players.find(p => p.id === playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не можете действовать' };
  if (game.night.blocked.includes(player.id)) return { ok: false, error: 'Вы заблокированы красавчиком' };

  const inMafiaTeam = (player.role === 'mafia' || player.role === 'don' || (player.role === 'rebel' && player.rebelAwakened));

  if (step.role === 'mafia_don' && inMafiaTeam) {
    const actionType = payload?.type || 'propose';

    if (actionType === 'confirm') {
      const proposal = game.night.proposals.mafia_don?.[player.id];
      if (!proposal) return { ok: false, error: 'Сначала выберите цель' };

      if (!game.night.confirmed.mafia_don) game.night.confirmed.mafia_don = {};
      game.night.confirmed.mafia_don[player.id] = true;

      if (!game.night.actions.mafia_don) game.night.actions.mafia_don = {};
      game.night.actions.mafia_don[player.id] = { mode: proposal.mode, targetId: proposal.targetId };

      tryAdvanceStep(roomId);
      return { ok: true, confirmed: true };
    }

    if (game.night.confirmed.mafia_don?.[player.id]) {
      return { ok: false, error: 'Вы уже подтвердили выбор' };
    }

    const mode = payload?.mode || 'kill';
    const targetId = payload?.targetId;
    const target = game.players.find(p => p.id === targetId && p.alive);
    if (!target) return { ok: false, error: 'Цель недоступна' };

    const targetInMafiaTeam = target.alive && (target.role === 'mafia' || target.role === 'don' || (target.role === 'rebel' && target.rebelAwakened));

    if (mode === 'kill' && targetInMafiaTeam) {
      return { ok: false, error: 'Нельзя голосовать за своих' };
    }

    if (mode === 'invite') {
      if (player.role !== 'don') {
        return { ok: false, error: 'Приглашать может только Дон' };
      }
      if (!canDonInvite(game)) {
        return { ok: false, error: 'Достигнут лимит мафий или приглашений' };
      }
      if (targetInMafiaTeam) {
        return { ok: false, error: 'Этот игрок уже мафия' };
      }

      game.recruitsLeft--;
      if (!game.night.proposals.mafia_don) game.night.proposals.mafia_don = {};
      game.night.proposals.mafia_don[player.id] = { mode: 'invite', targetId: target.id };

      const isSpecialRole = UNRECRUITABLE.includes(target.role);
      if (isSpecialRole) {
        game.pendingDonFeedback = `Игрок ${target.name} отклонил приглашение`;
      }

      broadcastNightState(roomId);
      return { ok: true, invite: 'pending', proposed: true };
    }

    if (!game.night.proposals.mafia_don) game.night.proposals.mafia_don = {};
    game.night.proposals.mafia_don[player.id] = { mode: 'kill', targetId: target.id };
    broadcastNightState(roomId);
    return { ok: true, proposed: true };
  }

  if (player.role === 'journalist' && step.role === 'journalist') {
    const arr = Array.isArray(payload) ? payload : payload?.targetId;
    if (!Array.isArray(arr) || arr.length !== 2) {
      return { ok: false, error: 'Нужно выбрать двух игроков' };
    }
    const a = game.players.find(p => p.id === arr[0] && p.alive);
    const b = game.players.find(p => p.id === arr[1] && p.alive);
    if (!a || !b || a.id === b.id) return { ok: false, error: 'Неверные цели' };

    if (!game.night.actions.journalist) game.night.actions.journalist = {};
    game.night.actions.journalist[player.id] = [a.id, b.id];

    const same = isSameTeam(a, b);
    io.to(player.socketId).emit('privateResult', {
      type: 'journalist',
      targets: [a.name, b.name],
      sameTeam: same,
      message: same
        ? `${a.name} и ${b.name} — в одной команде`
        : `${a.name} и ${b.name} — в разных командах`
    });

    tryAdvanceStep(roomId);
    return { ok: true };
  }

  if (player.role !== step.role) return { ok: false, error: 'Сейчас не ваш ход' };

  if (player.role === 'doctor' && payload?.self) {
    if (game.night.doctorSelfUsed) return { ok: false, error: 'Вы уже лечили себя' };
    if (game.night.lastDoctorTarget === player.id) {
      return { ok: false, error: 'Нельзя лечить одного и того же дважды подряд' };
    }
    if (!game.night.actions.doctor) game.night.actions.doctor = {};
    game.night.actions.doctor[player.id] = player.id;
    game.doctorSelfUsed = true;
    tryAdvanceStep(roomId);
    return { ok: true };
  }

  const targetId = Array.isArray(payload) ? payload[0] : (payload?.targetId ?? payload);
  const target = game.players.find(p => p.id === targetId);
  if (!target || !target.alive) return { ok: false, error: 'Цель недоступна' };

  if (player.role === 'doctor') {
    if (target.id === player.id && game.night.doctorSelfUsed) {
      return { ok: false, error: 'Вы уже лечили себя' };
    }
    if (game.night.lastDoctorTarget === target.id) {
      return { ok: false, error: 'Нельзя лечить одного и того же дважды подряд' };
    }
  }
  if (player.role === 'beauty') {
    if (target.id === player.id) return { ok: false, error: 'Нельзя выбрать себя' };
    if (game.lastBeautyTarget === target.id) {
      return { ok: false, error: 'Нельзя выбрать того же игрока дважды подряд' };
    }
  }

  if (!game.night.actions[player.role]) game.night.actions[player.role] = {};
  game.night.actions[player.role][player.id] = target.id;

  if (player.role === 'beauty') {
    if (!game.night.blocked.includes(target.id)) game.night.blocked.push(target.id);
  }

  if (player.role === 'sheriff') {
    let reportedRole = target.role;
    // Мятежник до пробуждения — как мирный
    if (target.role === 'rebel' && !target.rebelAwakened) {
      reportedRole = 'citizen';
    }
    // Если мятежник проснулся — как мафия
    if (target.role === 'rebel' && target.rebelAwakened) {
      reportedRole = 'mafia';
    }
    const isMafia = reportedRole === 'mafia' || reportedRole === 'don';
    io.to(player.socketId).emit('privateResult', {
      type: 'sheriff',
      target: target.name,
      targetRole: reportedRole,
      targetRoleName: roleNameRu(reportedRole),
      isMafia,
      message: `${target.name} — ${roleNameRu(reportedRole)}`
    });
  }

  tryAdvanceStep(roomId);
  return { ok: true };
}

function handleBlockedPass(roomId, playerId) {
  const game = games[roomId];
  if (!game || game.phase !== 'night') return { ok: false, error: 'Не ночь' };

  const player = game.players.find(p => p.id === playerId);
  if (!player || !player.alive) return { ok: false, error: 'Игрок недоступен' };
  if (!game.night.blocked.includes(player.id)) return { ok: false, error: 'Вы не заблокированы' };

  const inMafiaTeam = (player.role === 'mafia' || player.role === 'don' || (player.role === 'rebel' && player.rebelAwakened));

  if (inMafiaTeam) {
    const others = game.players.filter(p =>
      p.alive && p.id !== playerId && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)) && !game.night.blocked.includes(p.id)
    );
    if (others.length > 0) {
      return { ok: false, error: 'Дождитесь коллег по команде' };
    }
    if (!game.night.confirmed.mafia_don) game.night.confirmed.mafia_don = {};
    game.night.confirmed.mafia_don[player.id] = true;
    if (!game.night.actions.mafia_don) game.night.actions.mafia_don = {};
    game.night.actions.mafia_don[player.id] = null;

    const step = game.night.steps[game.night.currentStepIndex];
    if (step && step.role === 'mafia_don') {
      tryAdvanceStep(roomId);
    } else {
      broadcastNightState(roomId);
    }
    return { ok: true };
  }

  const sameRoleAlive = game.players.filter(p =>
    p.alive && p.role === player.role && p.id !== player.id && !game.night.blocked.includes(p.id)
  );
  if (sameRoleAlive.length > 0) {
    return { ok: false, error: 'Дождитесь коллег по роли' };
  }

  if (!game.night.actions[player.role]) game.night.actions[player.role] = {};
  game.night.actions[player.role][player.id] = null;

  const step = game.night.steps[game.night.currentStepIndex];
  if (step && step.role === player.role) {
    tryAdvanceStep(roomId);
  } else {
    broadcastNightState(roomId);
  }
  return { ok: true };
}

function tryAdvanceStep(roomId) {
  const game = games[roomId];
  if (!game) return;
  const step = game.night.steps[game.night.currentStepIndex];
  if (!step) return;

  const role = step.role;

  if (role === 'mafia_don') {
    if (!allMafiaDonConfirmed(game)) {
      broadcastNightState(roomId);
      return;
    }

    const actionsMap = game.night.actions.mafia_don || {};
    const aliveTeam = game.players.filter(p =>
      p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)) && !game.night.blocked.includes(p.id)
    );

    const actualVoters = aliveTeam.filter(p => actionsMap[p.id] !== null);

    const anyInvite = actualVoters.some(p => actionsMap[p.id] && actionsMap[p.id].mode === 'invite');
    if (anyInvite) {
      broadcastNightState(roomId);
      setTimeout(() => nextNightStep(roomId), 600);
      return;
    }

    const killTargets = actualVoters
      .filter(p => actionsMap[p.id] && actionsMap[p.id].mode === 'kill')
      .map(p => actionsMap[p.id].targetId);

    if (killTargets.length === 0) {
      broadcastNightState(roomId);
      setTimeout(() => nextNightStep(roomId), 600);
      return;
    }

    if (killTargets.every(t => t === killTargets[0])) {
      broadcastNightState(roomId);
      setTimeout(() => nextNightStep(roomId), 600);
      return;
    }

    broadcastNightState(roomId);
    return;
  }

  const rolePlayers = game.players.filter(p =>
    p.alive && p.role === role && !game.night.blocked.includes(p.id)
  );
  const allDone = rolePlayers.every(p => {
    if (role === 'journalist') return Array.isArray(game.night.actions.journalist?.[p.id]);
    return game.night.actions[role]?.[p.id] !== undefined;
  });

  if (!allDone) {
    broadcastNightState(roomId);
    return;
  }

  broadcastNightState(roomId);
  setTimeout(() => nextNightStep(roomId), 600);
}

function finishNight(roomId) {
  const game = games[roomId];
  if (!game) return;
  if (game.night.timerHandle) {
    clearTimeout(game.night.timerHandle);
    game.night.timerHandle = null;
  }

  const journal = [];
  const deaths = [];

  const map = game.night.actions.mafia_don || {};
  const mafiaTeamAlive = game.players.filter(p => p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened)));
  const actualVoters = mafiaTeamAlive.filter(p => map[p.id] !== null && map[p.id] !== undefined);
  const anyInvite = actualVoters.some(p => map[p.id] && map[p.id].mode === 'invite');
  let mafiaVictim = null;

  if (anyInvite) {
    const inviter = actualVoters.find(p => map[p.id] && map[p.id].mode === 'invite');
    if (inviter) {
      const tId = map[inviter.id].targetId;
      const target = game.players.find(p => p.id === tId);
      journal.push(`Дон пригласил: ${target ? target.name : '?'}`);
    }
  } else {
    const killTargets = actualVoters
      .filter(p => map[p.id] && map[p.id].mode === 'kill')
      .map(p => map[p.id].targetId);
    if (killTargets.length && killTargets.every(t => t === killTargets[0])) {
      mafiaVictim = killTargets[0];
      journal.push(`Мафия единогласно выбрала: ${nameOf(game, mafiaVictim)}`);
    } else if (actualVoters.length) {
      journal.push(`Мафия НЕ договорилась — жертвы нет`);
    }
  }

  const maniacAlive = game.players.filter(p => p.alive && p.role === 'maniac' && !game.night.blocked.includes(p.id));
  let maniacVictim = null;
  if (maniacAlive.length) {
    const maniacMap = game.night.actions.maniac || {};
    maniacVictim = maniacMap[maniacAlive[0].id] || null;
    if (maniacVictim) journal.push(`Маньяк выбрал: ${nameOf(game, maniacVictim)}`);
  } else if (game.players.some(p => p.alive && p.role === 'maniac')) {
    journal.push(`Маньяк был заблокирован красавчиком`);
  }

  let doctorSaved = null;
  const doctorAlive = game.players.filter(p => p.alive && p.role === 'doctor' && !game.night.blocked.includes(p.id));
  if (doctorAlive.length) {
    const docMap = game.night.actions.doctor || {};
    const docTarget = docMap[doctorAlive[0].id];
    if (docTarget) {
      doctorSaved = docTarget;
      journal.push(`Доктор лечил: ${nameOf(game, docTarget)}`);
      game.lastDoctorTarget = docTarget;
    }
  } else if (game.players.some(p => p.alive && p.role === 'doctor')) {
    journal.push(`Доктор был заблокирован красавчиком`);
  }

  // Собираем жертв
  const victims = new Set();
  if (mafiaVictim) victims.add(mafiaVictim);
  if (maniacVictim) victims.add(maniacVictim);
  if (doctorSaved) victims.delete(doctorSaved);

  victims.forEach(id => {
    const p = game.players.find(pp => pp.id === id);
    if (!p) return;

    // Телохранитель с 2 жизнями
    if (p.role === 'bodyguard' && p.bodyguardLives > 1) {
      p.bodyguardLives--;
      journal.push(`Телохранитель ${p.name} выжил благодаря бронежилету (осталось ${p.bodyguardLives})`);
      return;
    }

    p.alive = false;
    deaths.push(p);
  });

  const sheriffAlive = game.players.filter(p => p.alive && p.role === 'sheriff' && !game.night.blocked.includes(p.id));
  if (sheriffAlive.length) {
    const sMap = game.night.actions.sheriff || {};
    const target = sMap[sheriffAlive[0].id];
    if (target) {
      const t = game.players.find(pp => pp.id === target);
      if (t) journal.push(`Следователь проверял: ${t.name} (${roleLabel(t.role)})`);
    }
  } else if (game.players.some(p => p.alive && p.role === 'sheriff')) {
    journal.push(`Следователь был заблокирован красавчиком`);
  }

  const journalistAlive = game.players.filter(p => p.alive && p.role === 'journalist' && !game.night.blocked.includes(p.id));
  if (journalistAlive.length) {
    const jMap = game.night.actions.journalist || {};
    const pair = jMap[journalistAlive[0].id];
    if (Array.isArray(pair) && pair.length === 2) {
      const a = game.players.find(pp => pp.id === pair[0]);
      const b = game.players.find(pp => pp.id === pair[1]);
      if (a && b) {
        const same = isSameTeam(a, b);
        journal.push(`Журналист сравнил: ${a.name} и ${b.name} — ${same ? 'одна команда' : 'разные команды'}`);
      }
    }
  } else if (game.players.some(p => p.alive && p.role === 'journalist')) {
    journal.push(`Журналист был заблокирован красавчиком`);
  }

  const beautyAlive = game.players.filter(p => p.alive && p.role === 'beauty' && !game.night.blocked.includes(p.id));
  if (beautyAlive.length) {
    const bMap = game.night.actions.beauty || {};
    const target = bMap[beautyAlive[0].id];
    if (target) {
      journal.push(`Красавчик заблокировал: ${nameOf(game, target)}`);
      game.lastBeautyTarget = target;
    }
  } else if (game.players.some(p => p.alive && p.role === 'beauty')) {
    journal.push(`Красавчик был заблокирован`);
  }

  let pendingInvite = null;
  if (anyInvite) {
    const inviter = actualVoters.find(p => map[p.id] && map[p.id].mode === 'invite');
    if (inviter) {
      const tId = map[inviter.id].targetId;
      const target = game.players.find(p => p.id === tId && p.alive);
      if (target && !UNRECRUITABLE.includes(target.role)) {
        pendingInvite = {
          targetId: target.id,
          targetName: target.name,
          byDonId: inviter.id
        };
        journal.push(`Приглашение отправлено игроку ${target.name} — ответ утром`);
      } else if (target) {
        journal.push(`Приглашение отправлено игроку ${target.name}`);
      }
    }
  }

  const results = {
    day: game.day,
    deaths: deaths.map(p => ({ id: p.id, name: p.name, role: p.role })),
    journal
  };
  game.lastNightResults = results;
  game.pendingInvites = pendingInvite ? [pendingInvite] : [];

  game.players.forEach(p => {
    if (!p.socketId) return;
    io.to(p.socketId).emit('nightEnded', {
      day: game.day,
      deaths: results.deaths.map(d => ({ id: d.id, name: d.name })),
      youDied: !p.alive,
      pendingInvite: pendingInvite && pendingInvite.targetId === p.id ? pendingInvite : null
    });
  });

  io.to(game.hostSocketId).emit('hostNightResults', results);
  io.to(game.hostSocketId).emit('hostNightState', buildHostNightState(game));

  game.phase = 'day';
  game.votes = {};
  game.nightImmunity = [];
  game.revoteCandidates = null;
  game.firstDay = false;
  game.mayorVetoed = false;

  if (game.night.actions.beauty) {
    const bAlive = game.players.filter(p => p.alive && p.role === 'beauty');
    if (bAlive.length) {
      const tId = game.night.actions.beauty[bAlive[0].id];
      if (tId) game.nightImmunity.push(tId);
    }
  }

  io.to(game.hostSocketId).emit('phaseChanged', { phase: 'day', day: game.day });
  broadcastDayState(roomId);

  // Проверка пробуждения мятежника (после ночи)
  // Сначала пробуждение — потом конец игры
  const rebelResult = tryAwakenRebel(roomId, 'night');

  checkGameEnd(roomId, rebelResult);
}

// ---------- День ----------
function broadcastDayState(roomId) {
  const game = games[roomId];
  if (!game) return;

  const playersForPlayers = game.players.map(p => ({
    id: p.id, name: p.name, alive: p.alive, connected: !!p.socketId
  }));

  game.players.forEach(p => {
    if (!p.socketId) return;
    const isMayor = p.role === 'mayor' && p.alive;
    const isBodyguard = p.role === 'bodyguard' && p.alive;
    const canMayorVeto = isMayor && !game.mayorUsed && !game.firstDay && !game.mayorVetoed;
    const canBodyguardSave = isBodyguard && !game.bodyguardUsed;

    io.to(p.socketId).emit('dayState', {
      day: game.day,
      alive: p.alive,
      yourRole: (p.role === 'rebel' && p.rebelAwakened) ? 'mafia' : p.role,
      yourId: p.id,
      firstDay: !!game.firstDay,
      players: playersForPlayers,
      votes: game.votes || {},
      immunity: game.nightImmunity || [],
      revoteCandidates: game.revoteCandidates || null,
      pendingInvite: (game.pendingInvites || []).find(inv => inv.targetId === p.id) || null,
      canMayorVeto,
      canBodyguardSave,
      mayorVetoed: !!game.mayorVetoed,
      bodyguardUsed: !!game.bodyguardUsed
    });
  });

  io.to(game.hostSocketId).emit('hostDayState', {
    day: game.day,
    firstDay: !!game.firstDay,
    players: game.players.map(p => ({
      id: p.id, name: p.name, role: p.role, alive: p.alive, connected: !!p.socketId,
      rebelAwakened: p.rebelAwakened || false,
      bodyguardLives: p.bodyguardLives || 0
    })),
    votes: game.votes || {},
    immunity: game.nightImmunity || [],
    revoteCandidates: game.revoteCandidates || null,
    hintsTotal: game.hintsTotal || 0,
    hintsUsed: game.hintsUsed || 0,
    mayorUsed: !!game.mayorUsed,
    mayorVetoed: !!game.mayorVetoed,
    bodyguardUsed: !!game.bodyguardUsed,
    bodyguardSaveTarget: game.bodyguardSaveTarget || null
  });
}

// ---------- Пробуждение мятежника ----------
// phase: 'night' | 'day' — от чего зависит минимальное количество добрых
function tryAwakenRebel(roomId, phase) {
  const game = games[roomId];
  if (!game) return { awakened: false };

  const rebel = game.players.find(p => p.role === 'rebel' && p.alive && !p.rebelAwakened);
  if (!rebel) return { awakened: false };

  // Есть ли ещё живые мафии/дон?
  const aliveMafiaTeam = game.players.filter(p => p.alive && (p.role === 'mafia' || p.role === 'don')).length;
  if (aliveMafiaTeam > 0) return { awakened: false };

  // Сколько добрых игроков (все, кроме мафии/дона/мятежника)
  const aliveGood = game.players.filter(p =>
    p.alive && p.role !== 'mafia' && p.role !== 'don' && p.role !== 'rebel'
  ).length;

  // Если последняя мафия убита ночью — нужно >= 2 добрых
  // Если казнена днём — нужно >= 3 добрых
  const minGood = phase === 'night' ? 2 : 3;

  if (aliveGood >= minGood) {
    rebel.rebelAwakened = true;
    io.to(game.hostSocketId).emit('rebelAwakened', { name: rebel.name });
    game.players.forEach(p => {
      if (!p.socketId) return;
      if (p.id === rebel.id) {
        io.to(p.socketId).emit('yourRole', {
          role: 'mafia',
          name: p.name,
          image: findImage('mafia'),
          rebelAwakened: true
        });
      } else {
        io.to(p.socketId).emit('rebelAwakened', { name: rebel.name });
      }
    });
    return { awakened: true };
  }

  return { awakened: false };
}

// ---------- Конец игры ----------
function endGameAndBroadcast(roomId, winner) {
  const game = games[roomId];
  if (!game) return;

  if (game.night && game.night.timerHandle) {
    clearTimeout(game.night.timerHandle);
    game.night.timerHandle = null;
  }

  const rolesList = game.players.map(p => ({
    id: p.id,
    name: p.name,
    role: (p.role === 'rebel' && p.rebelAwakened) ? 'mafia' : p.role,
    originalRole: p.role,
    alive: p.alive,
    rebelAwakened: p.rebelAwakened || false
  }));

  const payload = { winner, roles: rolesList };

  io.to(game.hostSocketId).emit('gameEnded', payload);
  game.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('gameEnded', payload);
  });

  delete games[roomId];
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('Подключился socket:', socket.id);

  socket.on('createRoom', (callback) => {
    const roomId = generateRoomId();
    const hostToken = nanoid(24);
    games[roomId] = {
      hostSocketId: socket.id,
      hostToken,
      players: [],
      phase: 'lobby',
      day: 0,
      firstDay: true,
      votes: {},
      nightImmunity: [],
      recruitsLeft: MAX_DON_RECRUITS,
      lastBeautyTarget: null,
      lastDoctorTarget: null,
      doctorSelfUsed: false,
      pendingDonFeedback: null,
      pendingInvites: [],
      hintsTotal: 0,
      hintsUsed: 0,
      mayorUsed: false,
      mayorVetoed: false,
      bodyguardUsed: false,
      bodyguardSaveTarget: null,
      mode: 'classic'
    };
    socket.join(roomId);
    socket.data.role = 'host';
    socket.data.roomId = roomId;
    callback({ ok: true, roomId, hostToken });
    sendLobbyState(roomId);
  });

  socket.on('reconnectHost', ({ roomId, hostToken }, callback) => {
    const game = games[roomId];
    if (!game || game.hostToken !== hostToken) {
      return callback({ ok: false, error: 'Неверный токен' });
    }
    game.hostSocketId = socket.id;
    socket.join(roomId);
    socket.data.role = 'host';
    socket.data.roomId = roomId;
    callback({ ok: true, roomId });
    sendLobbyState(roomId);
    io.to(socket.id).emit('phaseChanged', { phase: game.phase, day: game.day });
    if (game.phase === 'night') broadcastNightState(roomId);
    if (game.phase === 'day') broadcastDayState(roomId);
  });

  socket.on('joinGame', ({ roomId, name, playerToken }, callback) => {
    const game = games[roomId];
    if (!game) return callback({ ok: false, error: 'Комната не найдена' });

    name = String(name || '').trim().slice(0, 20);
    if (!name) return callback({ ok: false, error: 'Введите имя' });

    if (playerToken) {
      const existing = game.players.find(p => p.token === playerToken);
      if (existing) {
        existing.socketId = socket.id;
        socket.join(roomId);
        socket.data.role = 'player';
        socket.data.roomId = roomId;
        socket.data.playerId = existing.id;
        callback({ ok: true, playerId: existing.id, playerToken: existing.token, reconnected: true });
        if (existing.role) {
          io.to(socket.id).emit('roleReconnect', {
            role: (existing.role === 'rebel' && existing.rebelAwakened) ? 'mafia' : existing.role,
            name: existing.name,
            image: findImage((existing.role === 'rebel' && existing.rebelAwakened) ? 'mafia' : existing.role)
          });
          io.to(socket.id).emit('phaseChanged', { phase: game.phase, day: game.day });
        }
        if (game.phase === 'night') broadcastNightState(roomId);
        if (game.phase === 'day') broadcastDayState(roomId);
        sendLobbyState(roomId);
        return;
      }
    }

    if (game.phase !== 'lobby') {
      return callback({ ok: false, error: 'Игра уже началась' });
    }
    if (game.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return callback({ ok: false, error: 'Такое имя уже занято' });
    }
    if (game.players.length >= 18) {
      return callback({ ok: false, error: 'Комната заполнена' });
    }

    const player = {
      id: nanoid(8),
      name,
      token: nanoid(24),
      socketId: socket.id,
      alive: true,
      role: null,
      rebelAwakened: false,
      bodyguardLives: 0
    };
    game.players.push(player);
    socket.join(roomId);
    socket.data.role = 'player';
    socket.data.roomId = roomId;
    socket.data.playerId = player.id;
    callback({ ok: true, playerId: player.id, playerToken: player.token });
    sendLobbyState(roomId);
  });

  socket.on('kickPlayer', ({ roomId, playerId }) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return;
    const idx = game.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const [removed] = game.players.splice(idx, 1);
    if (removed.socketId) {
      io.to(removed.socketId).emit('kicked');
      io.sockets.sockets.get(removed.socketId)?.leave(roomId);
    }
    sendLobbyState(roomId);
  });

  socket.on('setPlayerRole', ({ roomId, playerId, role }) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return;
    if (game.phase !== 'lobby') return;
    const allowed = ['mafia', 'sheriff', 'doctor', 'citizen', 'maniac', 'beauty', 'journalist', 'don', 'mayor', 'bodyguard', 'rebel'];
    if (role !== null && !allowed.includes(role)) return;
    const player = game.players.find(p => p.id === playerId);
    if (!player) return;
    player.role = role;
    sendLobbyState(roomId);
  });

  socket.on('startGame', ({ roomId }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    if (game.phase !== 'lobby') return callback?.({ ok: false, error: 'Игра уже идёт' });
    if (game.players.length < 4) return callback?.({ ok: false, error: 'Минимум 4 игрока' });

    const result = assignRoles(game.players);
    if (!result) return callback?.({ ok: false, error: 'Не удалось раздать роли' });

    game.phase = 'day';
    game.day = 0;
    game.firstDay = true;
    game.recruitsLeft = MAX_DON_RECRUITS;
    game.nightImmunity = [];
    game.lastBeautyTarget = null;
    game.lastDoctorTarget = null;
    game.doctorSelfUsed = false;
    game.pendingDonFeedback = null;
    game.pendingInvites = [];
    game.hintsTotal = 0;
    game.hintsUsed = 0;
    game.mayorUsed = false;
    game.mayorVetoed = false;
    game.bodyguardUsed = false;
    game.bodyguardSaveTarget = null;

    game.players.forEach(p => {
      if (p.socketId) {
        io.to(p.socketId).emit('yourRole', {
          role: p.role,
          name: p.name,
          image: findImage(p.role)
        });
        io.to(p.socketId).emit('phaseChanged', { phase: 'day', day: 0 });
      }
    });

    io.to(game.hostSocketId).emit('gameState', {
      roomId,
      phase: 'day',
      day: 0,
      firstDay: true,
      mafiaCount: result.mafiaCount,
      players: game.players.map(p => ({
        id: p.id, name: p.name, alive: p.alive, connected: !!p.socketId, role: p.role,
        rebelAwakened: p.rebelAwakened || false
      }))
    });
    io.to(game.hostSocketId).emit('phaseChanged', { phase: 'day', day: 0 });

    broadcastDayState(roomId);
    callback?.({ ok: true });
  });

  socket.on('startNight', ({ roomId }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    if (game.phase !== 'day' && game.phase !== 'roles') {
      return callback?.({ ok: false, error: 'Сейчас нельзя начать ночь' });
    }
    beginNight(roomId);
    callback?.({ ok: true });
  });

  socket.on('endGame', ({ roomId }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    endGameAndBroadcast(roomId, 'manual');
    callback?.({ ok: true });
  });

  socket.on('nightAction', ({ roomId, targetId, mode, type, self }, callback) => {
    const res = handleNightAction(roomId, socket.data.playerId, { targetId, mode, type, self });
    callback?.(res);
  });

  socket.on('nightPass', ({ roomId }, callback) => {
    const res = handleBlockedPass(roomId, socket.data.playerId);
    callback?.(res);
  });

  socket.on('respondInvite', ({ roomId, accept }, callback) => {
    const game = games[roomId];
    if (!game) return callback?.({ ok: false });
    const player = game.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive) return callback?.({ ok: false });

    const inv = (game.pendingInvites || []).find(x => x.targetId === player.id);
    if (!inv) return callback?.({ ok: false, error: 'Нет приглашения' });

    if (accept) {
      // Если мятежник — становится мафией + rebelAwakened
      if (player.role === 'rebel') {
        player.role = 'mafia';
        player.rebelAwakened = true;
      } else {
        player.role = 'mafia';
      }
      io.to(player.socketId).emit('yourRole', {
        role: 'mafia',
        name: player.name,
        image: findImage('mafia')
      });
      game.pendingDonFeedback = `Игрок ${player.name} принял приглашение`;
      io.to(game.hostSocketId).emit('inviteResult', { name: player.name, accepted: true });
    } else {
      game.pendingDonFeedback = `Игрок ${player.name} отклонил приглашение`;
      io.to(game.hostSocketId).emit('inviteResult', { name: player.name, accepted: false });
    }

    game.pendingInvites = game.pendingInvites.filter(x => x.targetId !== player.id);
    broadcastDayState(roomId);
    callback?.({ ok: true });
  });

  // ---- Мер: отменить голосование ----
  socket.on('mayorVeto', ({ roomId }, callback) => {
    const game = games[roomId];
    if (!game || game.phase !== 'day') return callback?.({ ok: false, error: 'Не день' });
    const player = game.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive) return callback?.({ ok: false, error: 'Игрок недоступен' });
    if (player.role !== 'mayor') return callback?.({ ok: false, error: 'Вы не мер' });
    if (game.mayorUsed) return callback?.({ ok: false, error: 'Способность уже использована' });
    if (game.firstDay) return callback?.({ ok: false, error: 'В первый день нельзя' });
    if (game.mayorVetoed) return callback?.({ ok: false, error: 'Уже отменено сегодня' });

    game.mayorUsed = true;
    game.mayorVetoed = true;
    game.votes = {};
    game.revoteCandidates = null;

    // Телохранитель НЕ тратит способность, но его выбор сбрасывается
    // (по требованию — если мер отменил, телохранитель не тратит)

    io.to(game.hostSocketId).emit('mayorVetoed', { name: player.name });
    game.players.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit('mayorVetoed', { name: player.name });
    });
    broadcastDayState(roomId);
    callback?.({ ok: true });
  });

  // ---- Телохранитель: спасти игрока от казни ----
  socket.on('bodyguardSave', ({ roomId, targetId }, callback) => {
    const game = games[roomId];
    if (!game || game.phase !== 'day') return callback?.({ ok: false, error: 'Не день' });
    const player = game.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive) return callback?.({ ok: false, error: 'Игрок недоступен' });
    if (player.role !== 'bodyguard') return callback?.({ ok: false, error: 'Вы не телохранитель' });
    if (game.bodyguardUsed) return callback?.({ ok: false, error: 'Способность уже использована' });

    const target = game.players.find(p => p.id === targetId && p.alive);
    if (!target) return callback?.({ ok: false, error: 'Цель недоступна' });
    if (target.id === player.id) return callback?.({ ok: false, error: 'Себя спасать нельзя' });

    game.bodyguardUsed = true;
    game.bodyguardSaveTarget = target.id;

    broadcastDayState(roomId);
    callback?.({ ok: true });
  });

  socket.on('setHintsTotal', ({ roomId, total }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    if (game.phase !== 'day') return callback?.({ ok: false, error: 'Подсказки доступны только днём' });
    total = parseInt(total, 10);
    if (!Number.isFinite(total) || total < 1 || total > 20) {
      return callback?.({ ok: false, error: 'Введите число от 1 до 20' });
    }
    game.hintsTotal = total;
    game.hintsUsed = 0;
    io.to(game.hostSocketId).emit('hintsTotalSet', { total });
    callback?.({ ok: true, total });
  });

  socket.on('giveHint', ({ roomId, playerId }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    if (game.phase !== 'day') return callback?.({ ok: false, error: 'Подсказки доступны только днём' });
    if (game.firstDay) return callback?.({ ok: false, error: 'В первый день подсказки недоступны' });
    if (!game.hintsTotal) return callback?.({ ok: false, error: 'Сначала задайте число подсказок' });
    if (game.hintsUsed >= game.hintsTotal) {
      return callback?.({ ok: false, error: 'Подсказки закончились' });
    }
    const player = game.players.find(p => p.id === playerId && p.alive);
    if (!player) return callback?.({ ok: false, error: 'Игрок недоступен' });

    const hint = generateHint(game, player.id);
    if (!hint) return callback?.({ ok: false, error: 'Не удалось сгенерировать подсказку' });

    game.hintsUsed++;
    io.to(player.socketId).emit('hintResult', hint);
    io.to(game.hostSocketId).emit('hintGiven', {
      playerName: player.name,
      current: game.hintsUsed,
      total: game.hintsTotal
    });
    callback?.({ ok: true, current: game.hintsUsed, total: game.hintsTotal });
  });

  socket.on('dayVote', ({ roomId, targetId }, callback) => {
    const game = games[roomId];
    if (!game || game.phase !== 'day') return callback?.({ ok: false, error: 'Не день' });
    if (game.firstDay) return callback?.({ ok: false, error: 'В первый день голосования нет' });
    if (game.mayorVetoed) return callback?.({ ok: false, error: 'Голосование отменено' });
    const voter = game.players.find(p => p.id === socket.data.playerId);
    if (!voter || !voter.alive) return callback?.({ ok: false, error: 'Вы не можете голосовать' });

    if (!game.votes) game.votes = {};
    if (targetId === null) {
      delete game.votes[voter.id];
    } else {
      const target = game.players.find(p => p.id === targetId && p.alive);
      if (!target) return callback?.({ ok: false, error: 'Цель недоступна' });
      if ((game.nightImmunity || []).includes(targetId)) {
        return callback?.({ ok: false, error: 'Этот игрок защищён Красавчиком' });
      }
      if (game.revoteCandidates && !game.revoteCandidates.includes(targetId)) {
        return callback?.({ ok: false, error: 'На переголосовании можно голосовать только за кандидатов' });
      }
      game.votes[voter.id] = target.id;
    }
    broadcastDayState(roomId);
    callback?.({ ok: true });
  });

  socket.on('finishDay', ({ roomId }, callback) => {
    const game = games[roomId];
    if (!game || game.hostSocketId !== socket.id) return callback?.({ ok: false, error: 'Нет доступа' });
    if (game.phase !== 'day') return callback?.({ ok: false, error: 'Не день' });

    // Если мер отменил — день закрывается без казни
    if (game.mayorVetoed) {
      game.mayorVetoed = false;
      game.phase = 'roles';
      const result = { day: game.day, lynched: null, tie: false, mayorVeto: true };
      io.to(game.hostSocketId).emit('dayResults', result);
      game.players.forEach(p => {
        if (!p.socketId) return;
        io.to(p.socketId).emit('dayResults', result);
        io.to(p.socketId).emit('phaseChanged', { phase: 'roles', day: game.day });
      });
      io.to(game.hostSocketId).emit('phaseChanged', { phase: 'roles', day: game.day });
      const rebelResult = tryAwakenRebel(roomId, 'day');
      checkGameEnd(roomId, rebelResult);
      return callback?.({ ok: true });
    }

    if (game.firstDay) {
      game.phase = 'roles';
      io.to(game.hostSocketId).emit('dayResults', { day: 0, lynched: null, tie: false, firstDay: true });
      game.players.forEach(p => {
        if (!p.socketId) return;
        io.to(p.socketId).emit('dayResults', { day: 0, lynched: null, tie: false, firstDay: true });
        io.to(p.socketId).emit('phaseChanged', { phase: 'roles', day: 0 });
      });
      io.to(game.hostSocketId).emit('phaseChanged', { phase: 'roles', day: 0 });
      return callback?.({ ok: true, firstDay: true });
    }

    const counts = {};
    Object.values(game.votes || {}).forEach(tid => {
      counts[tid] = (counts[tid] || 0) + 1;
    });

    let max = 0, top = [];
    for (const [tid, c] of Object.entries(counts)) {
      if (c > max) { max = c; top = [tid]; }
      else if (c === max) top.push(tid);
    }

    if (top.length > 1 && max > 0 && !game.revoteCandidates) {
      game.revoteCandidates = top.slice();
      game.votes = {};
      broadcastDayState(roomId);
      io.to(game.hostSocketId).emit('revoteStarted', { candidates: top.map(id => {
        const p = game.players.find(pp => pp.id === id);
        return p ? { id: p.id, name: p.name } : null;
      }).filter(Boolean) });
      return callback?.({ ok: true, revote: true });
    }

    if (top.length > 1 && game.revoteCandidates) {
      game.votes = {};
      game.revoteCandidates = null;
      game.phase = 'roles';
      const result = { day: game.day, lynched: null, tie: true };
      io.to(game.hostSocketId).emit('dayResults', result);
      game.players.forEach(p => {
        if (!p.socketId) return;
        io.to(p.socketId).emit('dayResults', result);
        io.to(p.socketId).emit('phaseChanged', { phase: 'roles', day: game.day });
      });
      io.to(game.hostSocketId).emit('phaseChanged', { phase: 'roles', day: game.day });
      const rebelResult = tryAwakenRebel(roomId, 'day');
      checkGameEnd(roomId, rebelResult);
      return callback?.({ ok: true });
    }

    let lynched = null;
    if (top.length === 1 && max > 0) {
      lynched = game.players.find(p => p.id === top[0]);
    }

    game.votes = {};
    game.revoteCandidates = null;
    game.phase = 'roles';

    // Проверка спасения
    let savedByBodyguard = false;
    let bodyguardSavedHimself = false;

    if (lynched) {
      // Телохранитель спасает выбранного
      if (game.bodyguardUsed && game.bodyguardSaveTarget === lynched.id) {
        savedByBodyguard = true;
      }
      // Телохранитель спасает себя (если 2 жизни)
      if (lynched.role === 'bodyguard' && lynched.bodyguardLives > 1) {
        bodyguardSavedHimself = true;
      }

      if (savedByBodyguard || bodyguardSavedHimself) {
        // никто не погиб
        if (bodyguardSavedHimself) {
          lynched.bodyguardLives--;
        }
      } else {
        lynched.alive = false;
      }
    }

    const result = {
      day: game.day,
      lynched: lynched ? { id: lynched.id, name: lynched.name, role: lynched.role } : null,
      tie: false,
      savedByBodyguard,
      bodyguardSavedHimself
    };

    io.to(game.hostSocketId).emit('dayResults', result);

    if (savedByBodyguard) {
      game.players.forEach(p => {
        if (p.socketId) io.to(p.socketId).emit('bodyguardSaved', { name: lynched.name });
      });
    }
    if (bodyguardSavedHimself) {
      game.players.forEach(p => {
        if (p.socketId) io.to(p.socketId).emit('bodyguardSaved', { name: lynched.name, self: true });
      });
    }

    game.players.forEach(p => {
      if (!p.socketId) return;
      io.to(p.socketId).emit('dayResults', result);
      io.to(p.socketId).emit('phaseChanged', { phase: 'roles', day: game.day });
    });
    io.to(game.hostSocketId).emit('phaseChanged', { phase: 'roles', day: game.day });

    // Проверка пробуждения мятежника (после дневной казни)
    const rebelResult = tryAwakenRebel(roomId, 'day');
    checkGameEnd(roomId, rebelResult);
    callback?.({ ok: true });
  });

  socket.on('peekPlayer', ({ roomId, playerId }, callback) => {
    const game = games[roomId];
    if (!game) return callback?.({ ok: false });
    const p = game.players.find(pp => pp.id === playerId);
    if (!p) return callback?.({ ok: false });
    callback?.({
      ok: true,
      name: p.name,
      alive: p.alive,
      image: findImage('unknown')
    });
  });

  socket.on('disconnect', () => {
    const { role, roomId, playerId } = socket.data || {};
    if (!roomId || !games[roomId]) return;
    const game = games[roomId];
    if (role === 'player') {
      const player = game.players.find(p => p.id === playerId);
      if (player && player.socketId === socket.id) {
        player.socketId = null;
        sendLobbyState(roomId);
      }
    }
  });
});

// ---------- Подсказки ----------
function generateHint(game, targetPlayerId) {
  const alive = game.players.filter(p => p.alive && p.id !== targetPlayerId);
  if (alive.length === 0) return null;

  const rand = Math.random();
  let howMany;
  if (rand < 0.33) howMany = 1;
  else if (rand < 0.66) howMany = 2;
  else howMany = 3;
  howMany = Math.min(alive.length, howMany);

  const shuffled = alive.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, howMany);

  const total = game.hintsTotal;
  const used = game.hintsUsed;
  const current = used + 1;
  const progress = total > 0 ? current / total : 1;

  const mafiaBase = 5 + 85 * progress;
  const peacefulBase = 5 + 45 * progress;

  const confuseIdx = (Math.random() < 0.2 && picked.length > 1)
    ? Math.floor(Math.random() * picked.length)
    : -1;

  const entries = picked.map((p, idx) => {
    const isMafiaTeam = (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened));
    let percent;
    if (isMafiaTeam) {
      percent = Math.round(mafiaBase + (Math.random() * 6 - 3));
      percent = Math.max(0, Math.min(100, percent));
    } else if (idx === confuseIdx) {
      percent = Math.round(mafiaBase + (Math.random() * 6 - 3));
      percent = Math.max(0, Math.min(100, percent));
    } else {
      percent = Math.round(peacefulBase + (Math.random() * 6 - 3));
      percent = Math.max(0, Math.min(50, percent));
    }
    return { id: p.id, name: p.name, percent };
  });

  entries.sort((a, b) => b.percent - a.percent);

  return { current, total, players: entries };
}

// ---------- Проверка конца игры ----------
// rebelResult — результат попытки пробуждения (если был)
function checkGameEnd(roomId, rebelResult) {
  const game = games[roomId];
  if (!game) return;

  const aliveMafia = game.players.filter(p =>
    p.alive && (p.role === 'mafia' || p.role === 'don' || (p.role === 'rebel' && p.rebelAwakened))
  ).length;

  const aliveManiac = game.players.filter(p => p.alive && p.role === 'maniac').length;

  const aliveCitizens = game.players.filter(p =>
    p.alive && p.role !== 'mafia' && p.role !== 'don' && p.role !== 'maniac'
    && !(p.role === 'rebel' && p.rebelAwakened)
  ).length;

  // Мятежник не пробудился, потому что не хватило добрых — победа мирных
  // (считаем: если мафий 0, маньяков 0, мятежник не пробуждён — мирные победили)
  if (aliveMafia === 0 && aliveManiac === 0) {
    endGameAndBroadcast(roomId, 'citizens');
    return;
  }

  // Маньяк остался один
  if (aliveManiac > 0 && aliveMafia === 0 && aliveCitizens === 0) {
    endGameAndBroadcast(roomId, 'maniac');
    return;
  }

  // Мафия победила
  if (aliveMafia > 0 && aliveMafia >= (aliveCitizens + aliveManiac)) {
    endGameAndBroadcast(roomId, 'mafia');
    return;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));
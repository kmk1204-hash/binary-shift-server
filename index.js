import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};
let waitingRandomTicketId = null;
const randomTickets = {};

/* =====================
   Roomライフサイクル設定
===================== */

/*
  最後の通信からこの時間を超えると、
  一時切断状態として扱う
*/
const PLAYER_DISCONNECT_AFTER_MS =
  15 * 1000;

/*
  誰も接続しておらず、
  操作も行われていないRoomの保持時間
*/
const ROOM_IDLE_TTL_MS =
  30 * 60 * 1000;

/*
  接続状態にかかわらずRoomを保持する絶対上限
*/
const ROOM_ABSOLUTE_TTL_MS =
  6 * 60 * 60 * 1000;

/*
  最終結果後に報酬取得を許可する時間
*/
const FINAL_RESULT_GRACE_MS =
  24 * 60 * 60 * 1000;

/*
  不要Roomを確認する間隔
*/
const ROOM_CLEANUP_INTERVAL_MS =
  60 * 1000;

const RANDOM_TICKET_TTL_MS =
  1000 * 60 * 3; // 3分


const RANDOM_REWARD_LIMIT_PER_ROOM =
  3;

const BINARY_SHIFT_SERVER_KEY =
  process.env.BINARY_SHIFT_SERVER_KEY || "";

if (!BINARY_SHIFT_SERVER_KEY) {

  console.error(
    "BINARY_SHIFT_SERVER_KEY is not configured"
  );

  process.exit(1);

}

/* =====================
   共有キー比較
===================== */

function safeCompareSecret(
  providedValue,
  expectedValue
) {

  if (
    typeof providedValue !== "string" ||
    typeof expectedValue !== "string"
  ) {
    return false;
  }

  const providedBuffer =
    Buffer.from(
      providedValue,
      "utf8"
    );

  const expectedBuffer =
    Buffer.from(
      expectedValue,
      "utf8"
    );

  if (
    providedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    providedBuffer,
    expectedBuffer
  );

}

/* =====================
   Wixバックエンド認証
===================== */

function requireWixBackend(
  req,
  res,
  next
) {

  const providedKey =
    req.get(
      "x-binary-shift-key"
    );

  if (
    !safeCompareSecret(
      providedKey,
      BINARY_SHIFT_SERVER_KEY
    )
  ) {

    return res.status(403).json({
      error: "Forbidden",
      reason: "invalid_server_key"
    });

  }

  next();

}

function cleanupRandomTickets() {
  const now = Date.now();

  for (const ticketId of Object.keys(randomTickets)) {
    const ticket = randomTickets[ticketId];

    if (!ticket) {
      delete randomTickets[ticketId];
      continue;
    }

    // 未マッチのまま古くなったticketを削除
    if (!ticket.matched && now - ticket.createdAt > RANDOM_TICKET_TTL_MS) {
      delete randomTickets[ticketId];

      if (waitingRandomTicketId === ticketId) {
        waitingRandomTicketId = null;
      }

      continue;
    }

    // マッチ済みticketも一定時間後に削除
    if (
      ticket.matched &&
      ticket.matchedAt &&
      now - ticket.matchedAt > RANDOM_TICKET_TTL_MS
    ) {
      delete randomTickets[ticketId];
      continue;
    }
  }

  // waitingRandomTicketId が壊れていたらリセット
  if (
    waitingRandomTicketId &&
    (
      !randomTickets[waitingRandomTicketId] ||
      randomTickets[waitingRandomTicketId].matched
    )
  ) {
    waitingRandomTicketId = null;
  }
}

/* =====================
   Roomと関連Ticketの削除
===================== */

function removeRoomAndRelatedTickets(
  roomId,
  reason = "unknown"
) {

  for (
    const ticketId of
    Object.keys(randomTickets)
  ) {

    const ticket =
      randomTickets[ticketId];

    if (
      ticket?.roomId !== roomId
    ) {
      continue;
    }

    delete randomTickets[
      ticketId
    ];

    if (
      waitingRandomTicketId === ticketId
    ) {

      waitingRandomTicketId =
        null;

    }

  }

  delete rooms[
    roomId
  ];

  console.log(
    `Room removed: ${roomId} (${reason})`
  );

}


/* =====================
   Room掃除
===================== */

function cleanupRooms() {

  const now =
    Date.now();

  for (
    const roomId of
    Object.keys(rooms)
  ) {

    const room =
      rooms[roomId];

    /*
      壊れたRoomデータを削除
    */

    if (!room) {

      delete rooms[
        roomId
      ];

      continue;

    }

    /*
      古いRoomにも
      ライフサイクル情報を補完
    */

    ensureRoomLifecycle(
      room
    );

    /* =====================
       最終結果後
    ===================== */

    /*
      final_resultのRoomは、
      通常のアイドルTTLや絶対TTLでは
      削除しない。

      報酬請求のため、
      finalResultAtから24時間保持する。
    */

    if (
      room.phase ===
      "final_result"
    ) {

      /*
        第23回④の反映前に作られたRoomや、
        古いRoomへの互換処理
      */

      if (
        !Number.isFinite(
          room.finalResultAt
        )
      ) {

        room.finalResultAt =
          now;

      }

      const finalResultExpired =
        now -
          room.finalResultAt >
        FINAL_RESULT_GRACE_MS;

      if (
        finalResultExpired
      ) {

        removeRoomAndRelatedTickets(
          roomId,
          "final_result_grace_expired"
        );

      }

      /*
        final_result中は、
        以下の通常TTL判定へ進まない
      */

      continue;

    }

    /* =====================
       両者が明示的に離脱
    ===================== */

    const bothPlayersLeft =
      room.leaveState
        ?.attack === true &&
      room.leaveState
        ?.defense === true;

    if (
      bothPlayersLeft
    ) {

      if (
        !Number.isFinite(
          room.closedAt
        )
      ) {

        room.closedAt =
          now;

      }

      removeRoomAndRelatedTickets(
        roomId,
        "both_players_left"
      );

      continue;

    }

    /* =====================
       Room絶対上限
    ===================== */

    const absoluteExpired =
      Number.isFinite(
        room.createdAt
      ) &&
      now -
        room.createdAt >
        ROOM_ABSOLUTE_TTL_MS;

    if (
      absoluteExpired
    ) {

      removeRoomAndRelatedTickets(
        roomId,
        "absolute_ttl_expired"
      );

      continue;

    }

    /* =====================
       接続状態
    ===================== */

    const attackConnected =
      isParticipantConnected(
        room,
        "attack",
        now
      );

    const defenseConnected =
      isParticipantConnected(
        room,
        "defense",
        now
      );

    /*
      どちらかが接続中なら、
      アイドルTTLでは削除しない
    */

    if (
      attackConnected ||
      defenseConnected
    ) {

      continue;

    }

    /* =====================
       アイドルTTL
    ===================== */

    const latestTimestamp =
      getLatestRoomTimestamp(
        room
      );

    const idleExpired =
      Number.isFinite(
        latestTimestamp
      ) &&
      now -
        latestTimestamp >
        ROOM_IDLE_TTL_MS;

    if (
      idleExpired
    ) {

      removeRoomAndRelatedTickets(
        roomId,
        "idle_ttl_expired"
      );

    }

  }

}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8);
}

function generateTicketId() {
  return Math.random().toString(36).substring(2, 10);
}

function generatePlayerId() {
  return Math.random().toString(36).substring(2, 12)
       + Date.now().toString(36);
}

function normalizeMemberInfo(body = {}) {

  const rawMemberId =
    typeof body.memberId === "string"
      ? body.memberId.trim()
      : "";

  const memberId =
    rawMemberId.length > 0 &&
    rawMemberId.length <= 128
      ? rawMemberId
      : null;

  return {
    memberId
  };

}


/* =====================
   Public Participants
===================== */

function createPublicParticipants(room, viewerPlayerId) {

  const attackIsYou =
    room.participants.attack.playerId === viewerPlayerId;

  const defenseIsYou =
    room.participants.defense.playerId === viewerPlayerId;

  return {
    attack: {
      playerId: attackIsYou
        ? room.participants.attack.playerId
        : null,

      isYou: attackIsYou,

      joined:
        !!room.participants.attack.playerId
    },

    defense: {
      playerId: defenseIsYou
        ? room.participants.defense.playerId
        : null,

      isYou: defenseIsYou,

      joined:
        !!room.participants.defense.playerId
    }
  };

}


function findWaitingTicketByClientId(clientId) {
  if (!clientId) return null;

  for (const ticketId of Object.keys(randomTickets)) {
    const ticket = randomTickets[ticketId];

    if (
      ticket &&
      !ticket.matched &&
      ticket.clientId === clientId
    ) {
      return ticketId;
    }
  }

  return null;
}

function findWaitingTicketByMemberId(memberId) {

  if (!memberId) {
    return null;
  }

  for (
    const ticketId of
    Object.keys(randomTickets)
  ) {

    const ticket =
      randomTickets[ticketId];

    if (
      ticket &&
      !ticket.matched &&
      ticket.memberId === memberId
    ) {
      return ticketId;
    }

  }

  return null;

}

/* =====================
   ランダムチケット所有者確認
===================== */

function isRandomTicketOwner(
  ticket,
  clientId
) {

  if (!ticket) {
    return false;
  }

  if (
    typeof clientId !== "string" ||
    !clientId.trim()
  ) {
    return false;
  }

  return (
    ticket.clientId ===
    clientId.trim()
  );

}

function createInitialRoom(
  type = "manual"
) {

  const now =
    Date.now();

  const room = {

    type,

    phase:
      "placement",

    round:
      1,

    /*
      Roomライフサイクル情報
    */
    createdAt:
      now,

    lastActivityAt:
      now,

    finalResultAt:
      null,

    closedAt:
      null,

    connectionState: {

      /*
        participant固定のattack側
      */
      attack: {
        lastSeenAt:
          null
      },

      /*
        participant固定のdefense側
      */
      defense: {
        lastSeenAt:
          null
      }

    },

    leaveState: {
      attack: false,
      defense: false
    },

    players: {

      attack: {
        hand: [],
        placedCards: []
      },

      defense: {
        hand: [],
        placedCards: []
      }

    },

    /*
      現在のラウンドにおける
      RoleとParticipantの対応
    */
    roles: {
      attack: "attack",
      defense: "defense"
    },

    /*
      試合開始時から固定の
      Participant情報
    */
    participants: {

      attack: {
        playerId: null,
        memberId: null
      },

      defense: {
        playerId: null,
        memberId: null
      }

    },

    totalScore: {
      attack: 0,
      defense: 0
    },

    finalBinary: {
      attack: null,
      defense: null
    },

    rewardMatchCount:
      0,

    rewardAppliedThisMatch:
      false,

    rewardResult:
      null,

    matchNumber:
      1,

    battleState:
      null,

    openInfo:
      null,

    openReady:
      null,

    lastReplaceIndex:
      null,

    nextRoundReady:
      null,

    rematchState: {
      attack: null,
      defense: null
    }

  };

  /*
    将来フィールドが増えた場合や、
    古いRoomデータが混在した場合にも
    必要項目を補完する
  */

  ensureRoomLifecycle(
    room
  );

  return room;

}


function getRolePlayer(room, role) {
  return room.players[role];
}

function swapRoles(room) {

  const tmp = room.roles.attack;

  room.roles.attack = room.roles.defense;
  room.roles.defense = tmp;

}

function resetRoomForBuild(room) {

  room.players.attack.hand = [];
  room.players.attack.placedCards = [];

  room.players.defense.hand = [];
  room.players.defense.placedCards = [];

  room.battleState = null;

  room.openInfo = null;
  room.openReady = null;

  room.lastReplaceIndex = null;

  room.nextRoundReady = null;

  room.phase = "placement";

}

/* =====================
   再戦用Room初期化
===================== */

function resetRoomForRematch(
  room
) {

  ensureRoomLifecycle(
    room
  );

  /*
    同一Room内の試合番号を進める
  */

  room.matchNumber =
    (
      room.matchNumber ??
      1
    ) + 1;

  room.round =
    1;

  room.totalScore = {
    attack: 0,
    defense: 0
  };

  room.finalBinary = {
    attack: null,
    defense: null
  };

  /*
    新しい試合では
    報酬計算を再実行できるようにする。

    rewardMatchCountは
    同一Room内の通算なのでリセットしない。
  */

  room.rewardAppliedThisMatch =
    false;

  room.rewardResult =
    null;

  /*
    前の試合の終了情報をリセット
  */

  room.finalResultAt =
    null;

  room.closedAt =
    null;

  /*
    Build開始状態へ戻す
  */

  resetRoomForBuild(
    room
  );

  room.rematchState = {
    attack: null,
    defense: null
  };

  room.leaveState = {
    attack: false,
    defense: false
  };

  /*
    再戦開始もRoom操作として記録
  */

  touchRoomActivity(
    room
  );

}

function createEmptyOpenInfo() {

  return {

    completed: false,

    defenseOpen: {
      zeroCount: 0,
      oneCount: 0,
      total: 0
    },

    attackScouted: {
      zeroCount: 0,
      oneCount: 0,
      total: 0
    }

  };

}

function countCards(cards) {
  return {
    zeroCount: cards.filter(c => c === 0).length,
    oneCount: cards.filter(c => c === 1).length,
    total: cards.length
  };
}

function makeScoutCounts(cards, scoutCount) {
  const shuffled = [...cards];

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }

  const picked = shuffled.slice(0, scoutCount);

  return {
    zeroCount: picked.filter(v => v === 0).length,
    oneCount: picked.filter(v => v === 1).length,
    total: picked.length
  };
}

function initializeBattleState(room) {

  const attackPlayer =
    getRolePlayer(room, "attack");

  const defensePlayer =
    getRolePlayer(room, "defense");

  attackPlayer.hand = [...attackPlayer.placedCards];
  defensePlayer.hand = [...defensePlayer.placedCards];

  room.battleState = {

    step: 1,

    currentRole: "attack",

    forcedFace: null,

    attackHand: attackPlayer.hand.map(card => ({
      value: card,
      owner: "attack"
    })),

    defenseHand: defensePlayer.hand.map(card => ({
      value: card,
      owner: "defense"
    })),

    pointArea: Array(6).fill(null)

  };

}


/* =====================
   Random Match Reward
===================== */

function calculateRandomMatchReward(attackScore, defenseScore) {

  const diff =
    Math.abs(attackScore - defenseScore);

  if (diff === 0) {
    return {
      winner: "draw",
      diff,
      attackPoint: 1,
      defensePoint: 1
    };
  }

  const winner =
    attackScore > defenseScore
      ? "attack"
      : "defense";

  const winnerPoint =
    Math.floor(diff / 2) + 1;

  if (winner === "attack") {
    return {
      winner,
      diff,
      attackPoint: winnerPoint,
      defensePoint: 1
    };
  }

  return {
    winner,
    diff,
    attackPoint: 1,
    defensePoint: winnerPoint
  };

}

function applyRandomMatchReward(room) {

  if (!room) {
    return null;
  }

  /*
    同じ試合で報酬計算済みの場合は、
    保存済みの結果をそのまま返す
  */
  if (room.rewardAppliedThisMatch) {
    return room.rewardResult;
  }

  /*
    ルーム対戦は報酬対象外
  */
  if (room.type !== "random") {

    room.rewardAppliedThisMatch = true;

    room.rewardResult = {
      applied: false,
      reason: "not_random_match"
    };

    return room.rewardResult;

  }

  /*
    同一Roomでの報酬対象は最大3試合
  */
  if (
    room.rewardMatchCount >=
    RANDOM_REWARD_LIMIT_PER_ROOM
  ) {

    room.rewardAppliedThisMatch = true;

    room.rewardResult = {
      applied: false,
      reason: "reward_limit_reached",

      rewardMatchCount:
        room.rewardMatchCount,

      rewardRemainingCount: 0
    };

    return room.rewardResult;

  }

  const attackParticipant =
    room.participants.attack;

  const defenseParticipant =
    room.participants.defense;

  /*
    Wix DataのAccountと紐づけるため、
    両者のmemberIdが必要
  */
  if (
    !attackParticipant?.memberId ||
    !defenseParticipant?.memberId
  ) {

    room.rewardAppliedThisMatch = true;

    room.rewardResult = {
      applied: false,
      reason: "missing_member_id"
    };

    return room.rewardResult;

  }

  /*
    万一マッチング処理をすり抜けても、
    同一アカウント同士には報酬を付与しない
  */
  if (
    attackParticipant.memberId ===
    defenseParticipant.memberId
  ) {

    room.rewardAppliedThisMatch =
      true;

    room.rewardResult = {
      applied: false,
      reason: "same_member_id",

      rewardMatchCount:
        room.rewardMatchCount,

      rewardRemainingCount:
        Math.max(
          0,
          RANDOM_REWARD_LIMIT_PER_ROOM -
          room.rewardMatchCount
        )
    };

    return room.rewardResult;

  }

  const attackScore =
    room.totalScore.attack;

  const defenseScore =
    room.totalScore.defense;

  /*
    報酬の計算だけを行う。
    Express内のAccountは更新しない。
  */
  const reward =
    calculateRandomMatchReward(
      attackScore,
      defenseScore
    );

  room.rewardMatchCount++;

  room.rewardAppliedThisMatch =
    true;

  room.rewardResult = {

    applied: true,

    winner:
      reward.winner,

    diff:
      reward.diff,

    attackScore,

    defenseScore,

    attackPoint:
      reward.attackPoint,

    defensePoint:
      reward.defensePoint,

    rewardMatchCount:
      room.rewardMatchCount,

    rewardRemainingCount:
      Math.max(
        0,
        RANDOM_REWARD_LIMIT_PER_ROOM -
        room.rewardMatchCount
      )

  };

  return room.rewardResult;

}
/* =====================
   ルーム作成
===================== */

app.post(
  "/api/create-room",
  requireWixBackend,
  (req, res) => {

    const roomId =
      generateRoomId();

    const room =
      createInitialRoom("manual");

    const playerId =
      generatePlayerId();

    const member =
      normalizeMemberInfo(req.body);

    if (!member.memberId) {

      return res.status(400).json({
        error: "memberId is required",
        reason: "missing_member_id"
      });

    }

    room.participants.attack.playerId =
      playerId;

    room.participants.attack.memberId =
      member.memberId;

    rooms[roomId] =
      room;

    return res.json({
      roomId,
      playerId
    });

  }
);

/* =====================
   Room離脱
===================== */

app.post(
  "/api/leave-room/:roomId",
  (req, res) => {

    const roomId =
      req.params.roomId;

    const room =
      rooms[roomId];

    /*
      すでにRoom削除済みなら、
      離脱完了として扱う
    */

    if (!room) {

      return res.json({
        success: true,
        alreadyRemoved: true,
        roomRemoved: true
      });

    }

    /*
      古いRoomにも
      ライフサイクル情報を補完
    */

    ensureRoomLifecycle(
      room
    );

    /*
      playerIdから本人を認証
    */

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    /*
      leaveStateは、
      試合開始時から固定の
      Participant単位で管理する
    */

    const participant =
      auth.access.participant;

    if (!room.leaveState) {

      room.leaveState = {
        attack: false,
        defense: false
      };

    }

    /*
      離脱操作もRoomへの操作なので、
      最終操作時刻を更新する
    */

    touchRoomActivity(
      room
    );

    /*
      明示的に離脱したParticipantは
      接続中として扱わない
    */

    if (
      room.connectionState?.[
        participant
      ]
    ) {

      room.connectionState[
        participant
      ].lastSeenAt =
        null;

    }

    /*
      同じ離脱リクエストが再送されても、
      trueを設定するだけなので安全
    */

    room.leaveState[
      participant
    ] = true;

    const bothPlayersLeft =
      room.leaveState.attack === true &&
      room.leaveState.defense === true;

    /*
      まだ片方だけの離脱
    */

    if (!bothPlayersLeft) {

      return res.json({
        success: true,

        alreadyRemoved: false,

        roomRemoved: false,

        retainedForReward:
          room.phase ===
          "final_result",

        participant,

        phase:
          room.phase,

        leaveState:
          room.leaveState
      });

    }

    /*
      両者の離脱が完了した時刻を記録
    */

    if (
      !Number.isFinite(
        room.closedAt
      )
    ) {

      room.closedAt =
        Date.now();

    }

    /* =====================
       最終結果後
    ===================== */

    /*
      final_resultのRoomは、
      Wix側の報酬請求に必要なため
      両者が離脱しても削除しない。

      cleanupRooms()が
      finalResultAtから24時間後に削除する。
    */

    if (
      room.phase ===
      "final_result"
    ) {

      /*
        古いRoomなどで
        finalResultAtがない場合の保険
      */

      if (
        !Number.isFinite(
          room.finalResultAt
        )
      ) {

        room.finalResultAt =
          Date.now();

      }

      return res.json({
        success: true,

        alreadyRemoved: false,

        roomRemoved: false,

        retainedForReward: true,

        participant,

        phase:
          room.phase,

        leaveState:
          room.leaveState,

        closedAt:
          room.closedAt,

        finalResultAt:
          room.finalResultAt,

        rewardGraceUntil:
          room.finalResultAt +
          FINAL_RESULT_GRACE_MS
      });

    }

    /* =====================
       最終結果前
    ===================== */

    /*
      最終結果前に両者が離脱した場合は、
      Roomと関連するRandom Match Ticketを
      まとめて削除する
    */

    removeRoomAndRelatedTickets(
      roomId,
      "both_players_left"
    );

    return res.json({
      success: true,

      alreadyRemoved: false,

      roomRemoved: true,

      retainedForReward: false,

      participant
    });

  }
);
/* =====================
   ランダムマッチ開始
===================== */

app.post(
  "/api/random-match",
  requireWixBackend,
  (req, res) => {

    cleanupRandomTickets();
    cleanupRooms();

    const clientId =
      typeof req.body?.clientId === "string"
        ? req.body.clientId.trim()
        : "";

    const member =
      normalizeMemberInfo(req.body);

    if (!clientId) {

      return res.status(400).json({
        error: "clientId is required"
      });

    }

    if (!member.memberId) {

      return res.status(401).json({
        error: "Login is required",
        reason: "missing_member_id"
      });

    }

    /*
      同じclientがすでに待機中なら、
      新しいticketを作らず既存ticketを返す
    */

    const existingWaitingTicketId =
      findWaitingTicketByClientId(
        clientId
      );

    if (existingWaitingTicketId) {

      const existingTicket =
        randomTickets[
          existingWaitingTicketId
        ];

      /*
        同じclientIdなのに、
        memberIdが異なる場合は拒否
      */

      if (
        existingTicket.memberId !==
        member.memberId
      ) {

        return res.status(403).json({
          error: "Ticket owner mismatch",
          reason: "ticket_owner_mismatch"
        });

      }

      return res.json({
        matched: false,
        ticketId:
          existingWaitingTicketId
      });

    }

    /*
      別タブ・別ブラウザであっても、
      同じアカウントがすでに待機中なら拒否
    */

    const existingMemberTicketId =
      findWaitingTicketByMemberId(
        member.memberId
      );

    if (existingMemberTicketId) {

      return res.status(409).json({
        error:
          "This account is already waiting",
        reason:
          "same_member_already_waiting"
      });

    }

    /*
      waitingRandomTicketIdが
      壊れていた場合はリセット
    */

    if (
      waitingRandomTicketId &&
      (
        !randomTickets[
          waitingRandomTicketId
        ] ||
        randomTickets[
          waitingRandomTicketId
        ].matched
      )
    ) {

      waitingRandomTicketId =
        null;

    }

    /*
      待機者がいない場合：
      自分が待機
    */

    if (!waitingRandomTicketId) {

      const ticketId =
        generateTicketId();

      randomTickets[ticketId] = {
        clientId,
        matched: false,
        roomId: null,
        role: null,
        playerId: null,
        memberId:
          member.memberId,
        createdAt:
          Date.now()
      };

      waitingRandomTicketId =
        ticketId;

      return res.json({
        matched: false,
        ticketId
      });

    }

    const firstTicketId =
      waitingRandomTicketId;

    const firstTicket =
      randomTickets[
        firstTicketId
      ];

    /*
      待機者が壊れていた場合
    */

    if (
      !firstTicket ||
      firstTicket.matched
    ) {

      const ticketId =
        generateTicketId();

      randomTickets[ticketId] = {
        clientId,
        matched: false,
        roomId: null,
        role: null,
        playerId: null,
        memberId:
          member.memberId,
        createdAt:
          Date.now()
      };

      waitingRandomTicketId =
        ticketId;

      return res.json({
        matched: false,
        ticketId
      });

    }

    /*
      待機者が自分自身のclientIdなら
      マッチさせない
    */

    if (
      firstTicket.clientId ===
      clientId
    ) {

      return res.json({
        matched: false,
        ticketId:
          firstTicketId
      });

    }

    /*
      同一Wixアカウント同士は
      マッチさせない
    */

    if (
      firstTicket.memberId ===
      member.memberId
    ) {

      return res.status(409).json({
        matched: false,
        error:
          "You cannot match with the same account",
        reason:
          "same_member_id"
      });

    }

    /*
      待機者がいる場合：
      マッチ成立
    */

    const secondTicketId =
      generateTicketId();

    randomTickets[
      secondTicketId
    ] = {
      clientId,
      matched: false,
      roomId: null,
      role: null,
      playerId: null,
      memberId:
        member.memberId,
      createdAt:
        Date.now()
    };

    const roomId =
      generateRoomId();

    const room =
      createInitialRoom(
        "random"
      );

    const attackPlayerId =
      generatePlayerId();

    const defensePlayerId =
      generatePlayerId();

    room.participants
      .attack.playerId =
        attackPlayerId;

    room.participants
      .attack.memberId =
        firstTicket.memberId;

    room.participants
      .defense.playerId =
        defensePlayerId;

    room.participants
      .defense.memberId =
        member.memberId;

    rooms[roomId] =
      room;

    randomTickets[
      firstTicketId
    ] = {
      ...randomTickets[
        firstTicketId
      ],

      matched: true,

      roomId,

      role: "attack",

      matchedAt:
        Date.now(),

      playerId:
        attackPlayerId
    };

    randomTickets[
      secondTicketId
    ] = {
      ...randomTickets[
        secondTicketId
      ],

      matched: true,

      roomId,

      role: "defense",

      matchedAt:
        Date.now(),

      playerId:
        defensePlayerId
    };

    waitingRandomTicketId =
      null;

    return res.json({
      matched: true,
      ticketId:
        secondTicketId,
      roomId,
      role: "defense",
      playerId:
        defensePlayerId
    });

  }
);

/* =====================
   ランダムマッチ状態確認
===================== */

app.get(
  "/api/random-match/:ticketId",
  (req, res) => {

    cleanupRandomTickets();
    cleanupRooms();

    const ticketId =
      req.params.ticketId;

    const ticket =
      randomTickets[ticketId];

    if (!ticket) {

      return res.status(404).json({
        error: "Ticket not found",
        reason: "ticket_not_found"
      });

    }

    const clientId =
      typeof req.query?.clientId === "string"
        ? req.query.clientId.trim()
        : "";

    if (!clientId) {

      return res.status(400).json({
        error: "clientId is required",
        reason: "missing_client_id"
      });

    }

    if (
      !isRandomTicketOwner(
        ticket,
        clientId
      )
    ) {

      return res.status(403).json({
        error: "Ticket owner mismatch",
        reason: "ticket_owner_mismatch"
      });

    }

    if (!ticket.matched) {

      return res.json({
        matched: false,
        ticketId
      });

    }

    return res.json({
      matched: true,
      ticketId,
      roomId:
        ticket.roomId,
      role:
        ticket.role,
      playerId:
        ticket.playerId
    });

  }
);

/* =====================
   ランダムマッチキャンセル
===================== */

app.post(
  "/api/random-match-cancel",
  (req, res) => {

    cleanupRandomTickets();
    cleanupRooms();

    const ticketId =
      typeof req.body?.ticketId === "string"
        ? req.body.ticketId.trim()
        : "";

    const clientId =
      typeof req.body?.clientId === "string"
        ? req.body.clientId.trim()
        : "";

    if (!ticketId) {

      return res.status(400).json({
        error: "ticketId is required",
        reason: "missing_ticket_id"
      });

    }

    if (!clientId) {

      return res.status(400).json({
        error: "clientId is required",
        reason: "missing_client_id"
      });

    }

    const ticket =
      randomTickets[ticketId];

    /*
      すでにTTLなどで削除済みなら、
      キャンセル完了として扱う
    */

    if (!ticket) {

      return res.json({
        success: true,
        alreadyRemoved: true
      });

    }

    if (
      !isRandomTicketOwner(
        ticket,
        clientId
      )
    ) {

      return res.status(403).json({
        error: "Ticket owner mismatch",
        reason: "ticket_owner_mismatch"
      });

    }

    /*
      マッチ成立後はキャンセル不可
    */

    if (ticket.matched) {

      return res.status(409).json({
        error: "Ticket already matched",
        reason: "ticket_already_matched"
      });

    }

    if (
      waitingRandomTicketId ===
      ticketId
    ) {

      waitingRandomTicketId =
        null;

    }

    delete randomTickets[
      ticketId
    ];

    return res.json({
      success: true,
      alreadyRemoved: false
    });

  }
);
/* =====================
   状態取得・接続確認
===================== */

app.get(
  "/api/room-state/:roomId",
  (req, res) => {

    /*
      現時点では旧cleanupRoomsも
      引き続き動かしておく
    */

    cleanupRooms();

    const roomId =
      req.params.roomId;

    const room =
      rooms[roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    /*
      古いRoomにも
      ライフサイクル項目を補完
    */

    ensureRoomLifecycle(
      room
    );

    /*
      queryのplayerIdから
      Room参加者本人かを確認
    */

    const auth =
      requireRoomPlayer(
        room,
        req.query
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const viewerPlayerId =
      auth.access.playerId;

    /*
      試合開始時から固定のParticipant
      attack / defense
    */

    const viewerParticipant =
      auth.access.participant;

    /*
      このプレイヤーが現在接続していることを記録
    */

    touchParticipantPresence(
      room,
      viewerParticipant
    );

    const publicParticipants =
      createPublicParticipants(
        room,
        viewerPlayerId
      );

    /*
      Participant単位の接続状態
    */

    const connectionState =
      getRoomConnectionState(
        room
      );

    /* =====================
       現在の攻守プレイヤー取得
    ===================== */

    const attackPlayer =
      getRolePlayer(
        room,
        "attack"
      );

    const defensePlayer =
      getRolePlayer(
        room,
        "defense"
      );

    const placementInfo = {

      attackCount:
        attackPlayer
          .placedCards
          .length,

      defenseCount:
        defensePlayer
          .placedCards
          .length,

      attackCards:
        attackPlayer
          .placedCards,

      defenseCards:
        defensePlayer
          .placedCards

    };

    /*
      再戦・終了選択状況
    */

    const matchEnd = {

      attack:
        room.rematchState
          ?.attack ??
        null,

      defense:
        room.rematchState
          ?.defense ??
        null

    };

    const rewardRemainingCount =
      Math.max(
        0,

        RANDOM_REWARD_LIMIT_PER_ROOM -
          room.rewardMatchCount
      );

    /* =====================
       最終結果
    ===================== */

    if (
      room.phase ===
      "final_result"
    ) {

      const attackScore =
        room.totalScore.attack;

      const defenseScore =
        room.totalScore.defense;

      let winner =
        "draw";

      if (
        attackScore >
        defenseScore
      ) {

        winner =
          "attack";

      }

      if (
        defenseScore >
        attackScore
      ) {

        winner =
          "defense";

      }

      return res.json({

        type:
          room.type,

        phase:
          room.phase,

        roles:
          room.roles,

        finalResultAt:
          room.finalResultAt,

        rewardGraceUntil:
          Number.isFinite(
            room.finalResultAt
          )
            ? room.finalResultAt +
              FINAL_RESULT_GRACE_MS
            : null,

        closedAt:
          room.closedAt,

        /*
          このリクエストを送った本人の
          Participant固定スロット
        */

        viewerParticipant,

        participants:
          publicParticipants,

        /*
          Participant固定の接続状態
        */

        connectionState,

        result: {

          attackScore,

          defenseScore,

          attackBinary:
            room.finalBinary.attack,

          defenseBinary:
            room.finalBinary.defense,

          winner

        },

        round:
          room.round,

        totalScore:
          room.totalScore,

        finalBinary:
          room.finalBinary,

        rewardMatchCount:
          room.rewardMatchCount,

        rewardRemainingCount,

        rewardResult:
          room.rewardResult ??
          null,

        matchNumber:
          room.matchNumber ??
          1,

        placementInfo,

        openInfo:
          room.openInfo ??
          null,

        openReady:
          room.openReady ??
          null,

        lastReplaceIndex:
          room.lastReplaceIndex ??
          null,

        nextRoundReady:
          room.nextRoundReady ??
          null,

        rematchState:
          room.rematchState,

        matchEnd

      });

    }

    /* =====================
       通常の対戦状態
    ===================== */

    return res.json({

      type:
        room.type,

      phase:
        room.phase,

      roles:
        room.roles,

      viewerParticipant,

      participants:
        publicParticipants,

      connectionState,

      battleState:
        room.battleState,

      round:
        room.round,

      totalScore:
        room.totalScore,

      rewardMatchCount:
        room.rewardMatchCount,

      rewardRemainingCount,

      rewardResult:
        room.rewardResult ??
        null,

      matchNumber:
        room.matchNumber ??
        1,

      placementInfo,

      openInfo:
        room.openInfo ??
        null,

      openReady:
        room.openReady ??
        null,

      lastReplaceIndex:
        room.lastReplaceIndex ??
        null,

      nextRoundReady:
        room.nextRoundReady ??
        null,

      rematchState:
        room.rematchState,

      matchEnd

    });

  }
);

/* =====================
   PlayerIdからParticipantを取得
===================== */

function getParticipantByPlayerId(
  room,
  playerId
) {

  if (
    room.participants.attack.playerId ===
    playerId
  ) {
    return {
      participant: "attack",
      data: room.participants.attack
    };
  }

  if (
    room.participants.defense.playerId ===
    playerId
  ) {
    return {
      participant: "defense",
      data: room.participants.defense
    };
  }

  return null;

}

/* =====================
   playerId整形
===================== */

function normalizePlayerId(
  body = {}
) {

  if (
    typeof body.playerId !==
    "string"
  ) {
    return null;
  }

  const playerId =
    body.playerId.trim();

  if (
    !playerId ||
    playerId.length > 128
  ) {
    return null;
  }

  return playerId;

}

/* =====================
   playerIdから現在のRoleを取得
===================== */

function getPlayerAccess(
  room,
  playerId
) {

  if (!room || !playerId) {
    return null;
  }

  const participantInfo =
    getParticipantByPlayerId(
      room,
      playerId
    );

  if (!participantInfo) {
    return null;
  }

  const participant =
    participantInfo.participant;

  let role =
    null;

  if (
    room.roles.attack ===
    participant
  ) {

    role = "attack";

  } else if (
    room.roles.defense ===
    participant
  ) {

    role = "defense";

  }

  if (!role) {
    return null;
  }

  return {
    playerId,

    /*
      試合開始時から固定
      attack / defense
    */
    participant,

    /*
      現在のラウンドでの役割
      attack / defense
    */
    role,

    participantData:
      participantInfo.data
  };

}

/* =====================
   API操作プレイヤー認証
===================== */

function requireRoomPlayer(
  room,
  body
) {

  const playerId =
    normalizePlayerId(
      body
    );

  if (!playerId) {

    return {
      ok: false,

      status: 400,

      response: {
        error:
          "playerId is required",

        reason:
          "missing_player_id"
      }
    };

  }

  const access =
    getPlayerAccess(
      room,
      playerId
    );

  if (!access) {

    return {
      ok: false,

      status: 403,

      response: {
        error:
          "Player is not in this room",

        reason:
          "player_not_in_room"
      }
    };

  }

  return {
    ok: true,
    access
  };

}

/* =====================
   Roomライフサイクル初期化
===================== */

function ensureRoomLifecycle(
  room
) {

  if (!room) {
    return;
  }

  const now =
    Date.now();

  if (
    !Number.isFinite(
      room.createdAt
    )
  ) {

    room.createdAt =
      now;

  }

  if (
    !Number.isFinite(
      room.lastActivityAt
    )
  ) {

    room.lastActivityAt =
      room.createdAt;

  }

  if (
    !Object.prototype.hasOwnProperty.call(
      room,
      "finalResultAt"
    )
  ) {

    room.finalResultAt =
      null;

  }

  if (
    !Object.prototype.hasOwnProperty.call(
      room,
      "closedAt"
    )
  ) {

    room.closedAt =
      null;

  }

  if (
    !room.connectionState ||
    typeof room.connectionState !==
      "object"
  ) {

    room.connectionState = {
      attack: {
        lastSeenAt: null
      },

      defense: {
        lastSeenAt: null
      }
    };

  }

  if (
    !room.connectionState.attack ||
    typeof room.connectionState.attack !==
      "object"
  ) {

    room.connectionState.attack = {
      lastSeenAt: null
    };

  }

  if (
    !room.connectionState.defense ||
    typeof room.connectionState.defense !==
      "object"
  ) {

    room.connectionState.defense = {
      lastSeenAt: null
    };

  }

  if (
    !Object.prototype.hasOwnProperty.call(
      room.connectionState.attack,
      "lastSeenAt"
    )
  ) {

    room.connectionState.attack.lastSeenAt =
      null;

  }

  if (
    !Object.prototype.hasOwnProperty.call(
      room.connectionState.defense,
      "lastSeenAt"
    )
  ) {

    room.connectionState.defense.lastSeenAt =
      null;

  }

}

/* =====================
   Room操作時刻更新
===================== */

function touchRoomActivity(
  room
) {

  if (!room) {
    return;
  }

  ensureRoomLifecycle(
    room
  );

  room.lastActivityAt =
    Date.now();

}

/* =====================
   プレイヤー接続時刻更新
===================== */

function touchParticipantPresence(
  room,
  participant
) {

  if (!room) {
    return;
  }

  if (
    participant !== "attack" &&
    participant !== "defense"
  ) {
    return;
  }

  ensureRoomLifecycle(
    room
  );

  room.connectionState[
    participant
  ].lastSeenAt =
    Date.now();

}

/* =====================
   プレイヤー接続判定
===================== */

function isParticipantConnected(
  room,
  participant,
  now = Date.now()
) {

  if (!room) {
    return false;
  }

  if (
    participant !== "attack" &&
    participant !== "defense"
  ) {
    return false;
  }

  ensureRoomLifecycle(
    room
  );

  const lastSeenAt =
    room.connectionState[
      participant
    ].lastSeenAt;

  if (
    !Number.isFinite(
      lastSeenAt
    )
  ) {
    return false;
  }

  return (
    now - lastSeenAt <=
    PLAYER_DISCONNECT_AFTER_MS
  );

}

/* =====================
   Room接続状態取得
===================== */

function getRoomConnectionState(
  room
) {

  const now =
    Date.now();

  ensureRoomLifecycle(
    room
  );

  return {
    attack: {
      connected:
        isParticipantConnected(
          room,
          "attack",
          now
        ),

      lastSeenAt:
        room.connectionState
          .attack
          .lastSeenAt
    },

    defense: {
      connected:
        isParticipantConnected(
          room,
          "defense",
          now
        ),

      lastSeenAt:
        room.connectionState
          .defense
          .lastSeenAt
    }
  };

}

/* =====================
   最後に確認された時刻
===================== */

function getLatestRoomTimestamp(
  room
) {

  ensureRoomLifecycle(
    room
  );

  const timestamps = [
    room.createdAt,
    room.lastActivityAt,
    room.connectionState
      .attack
      .lastSeenAt,
    room.connectionState
      .defense
      .lastSeenAt
  ].filter(
    value =>
      Number.isFinite(value)
  );

  if (
    timestamps.length === 0
  ) {

    return Date.now();

  }

  return Math.max(
    ...timestamps
  );

}

/* =====================
   Participant別報酬生成
===================== */

function createParticipantReward(
  roomId,
  room,
  participant
) {

  const reward =
    room.rewardResult;

  if (!reward) {
    return {
      eligible: false,
      reason: "reward_not_ready"
    };
  }

  if (!reward.applied) {
    return {
      eligible: false,
      reason:
        reward.reason ||
        "reward_not_applied",

      roomId,

      matchNumber:
        room.matchNumber ?? 1,

      participant
    };
  }

  const point =
    participant === "attack"
      ? reward.attackPoint
      : reward.defensePoint;

  let result =
    "lose";

  if (reward.winner === "draw") {

    result = "draw";

  } else if (
    reward.winner === participant
  ) {

    result = "win";

  }

  const matchNumber =
    room.matchNumber ?? 1;

  const rewardId =
    `${roomId}_${matchNumber}_${participant}`;

  return {
    eligible: true,

    rewardId,

    roomId,

    matchNumber,

    participant,

    point:
      Number(point ?? 0),

    result,

    winner:
      reward.winner,

    diff:
      reward.diff,

    rewardMatchCount:
      reward.rewardMatchCount,

    rewardRemainingCount:
      reward.rewardRemainingCount
  };

}

/* =====================
   配置フェーズ
   ※ 実質 build：3枚のカード選択
===================== */

app.post(
  "/api/placement/place/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "placement"
    ) {

      return res.status(400).json({
        error:
          "Not placement phase",

        reason:
          "invalid_phase"
      });

    }

    /*
      playerIdから本人と
      現在のRoleを判定
    */

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    const card =
      req.body?.card;

    if (
      card !== 0 &&
      card !== 1
    ) {

      return res.status(400).json({
        error: "Invalid card",
        reason: "invalid_card"
      });

    }

    /*
      現在のRoleに対応する
      プレイヤーデータを取得
    */

    const player =
      getRolePlayer(
        room,
        role
      );

    if (!player) {

      return res.status(400).json({
        error: "Player not found",

        reason:
          "player_data_not_found"
      });

    }

    if (
      player.placedCards.length >=
      3
    ) {

      return res.status(400).json({
        error: "Already placed",
        reason: "already_placed"
      });

    }

    player.placedCards.push(
      card
    );

    const attackPlayer =
      getRolePlayer(
        room,
        "attack"
      );

    const defensePlayer =
      getRolePlayer(
        room,
        "defense"
      );

    const attackCount =
      attackPlayer
        .placedCards
        .length;

    const defenseCount =
      defensePlayer
        .placedCards
        .length;

    /*
      両者のBuildが完了したら
      Openへ進行
    */

    if (
      attackCount === 3 &&
      defenseCount === 3
    ) {

      room.phase =
        "open";

      room.openInfo =
        createEmptyOpenInfo();

      room.battleState =
        null;

    }

    /*
      カード追加または
      フェーズ進行が行われた
    */

    touchRoomActivity(
      room
    );

    return res.json({
      success: true,

      phase:
        room.phase,

      role,

      attackCount,

      defenseCount,

      placementInfo: {

        attackCount,

        defenseCount,

        attackCards:
          attackPlayer
            .placedCards,

        defenseCards:
          defensePlayer
            .placedCards
      },

      openInfo:
        room.openInfo,

      battleState:
        room.battleState
    });

  }
);

/* =====================
   openフェーズ：
   defenseが公開情報を確定
===================== */

/* =====================
   openフェーズ：
   defenseが公開情報を確定
===================== */

app.post(
  "/api/open/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "open"
    ) {

      return res.status(400).json({
        error: "Not open phase",
        reason: "invalid_phase"
      });

    }

    /*
      playerIdから本人と
      現在のRoleを判定
    */

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    /*
      公開内容を確定できるのは
      現在のdefenseだけ
    */

    if (
      role !==
      "defense"
    ) {

      return res.status(403).json({
        error:
          "Only defense can open",

        reason:
          "defense_only"
      });

    }

    if (
      room.openInfo &&
      room.openInfo.completed
    ) {

      return res.status(400).json({
        error:
          "Open already completed",

        reason:
          "open_already_completed"
      });

    }

    const selectedIndexes =
      req.body?.selectedIndexes;

    if (
      !Array.isArray(
        selectedIndexes
      )
    ) {

      return res.status(400).json({
        error:
          "Invalid selected indexes",

        reason:
          "invalid_selected_indexes"
      });

    }

    if (
      selectedIndexes.length >
      3
    ) {

      return res.status(400).json({
        error:
          "Too many selected cards",

        reason:
          "too_many_selected_cards"
      });

    }

    /*
      現在の攻守プレイヤー取得
    */

    const defensePlayer =
      getRolePlayer(
        room,
        "defense"
      );

    const attackPlayer =
      getRolePlayer(
        room,
        "attack"
      );

    const defenseCards =
      defensePlayer
        .placedCards;

    const attackCards =
      attackPlayer
        .placedCards;

    if (
      defenseCards.length !== 3 ||
      attackCards.length !== 3
    ) {

      return res.status(400).json({
        error:
          "Build not completed",

        reason:
          "build_not_completed"
      });

    }

    /*
      選択位置の検証
    */

    const indexSet =
      new Set();

    for (
      const rawIndex of
      selectedIndexes
    ) {

      const index =
        Number(
          rawIndex
        );

      if (
        !Number.isInteger(
          index
        )
      ) {

        return res.status(400).json({
          error:
            "Invalid selected index",

          reason:
            "invalid_selected_index"
        });

      }

      if (
        index < 0 ||
        index > 2
      ) {

        return res.status(400).json({
          error:
            "Selected index out of range",

          reason:
            "selected_index_out_of_range"
        });

      }

      if (
        indexSet.has(
          index
        )
      ) {

        return res.status(400).json({
          error:
            "Duplicate selected index",

          reason:
            "duplicate_selected_index"
        });

      }

      indexSet.add(
        index
      );

    }

    const selectedCards =
      [...indexSet].map(
        index =>
          defenseCards[index]
      );

    const defenseOpen =
      countCards(
        selectedCards
      );

    const scoutCount =
      Math.max(
        0,
        defenseOpen.total - 1
      );

    const attackScouted =
      makeScoutCounts(
        attackCards,
        scoutCount
      );

    room.openInfo = {
      completed: true,
      defenseOpen,
      attackScouted
    };

    room.openReady = {
      attack: false,
      defense: false
    };

    room.phase =
      "open";

    room.battleState =
      null;

    /*
      Defenseが公開情報を確定した
    */

    touchRoomActivity(
      room
    );

    return res.json({
      success: true,

      phase:
        room.phase,

      role,

      openInfo:
        room.openInfo,

      openReady:
        room.openReady,

      battleState:
        room.battleState
    });

  }
);

/* =====================
   open確認完了
===================== */

app.post(
  "/api/open-ready/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "open"
    ) {

      return res.status(400).json({
        error: "Not open phase",
        reason: "invalid_phase"
      });

    }

    /*
      playerIdから本人と
      現在のRoleを判定
    */

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    if (
      !room.openInfo ||
      !room.openInfo.completed
    ) {

      return res.status(400).json({
        error:
          "Open not completed",

        reason:
          "open_not_completed"
      });

    }

    if (!room.openReady) {

      room.openReady = {
        attack: false,
        defense: false
      };

    }

    /*
      playerIdから判定した
      現在Roleをreadyへ反映
    */

    room.openReady[
      role
    ] = true;

    /*
      まだ片方だけ確認完了
    */

    if (
      !room.openReady.attack ||
      !room.openReady.defense
    ) {

      touchRoomActivity(
        room
      );

      return res.json({
        success: true,

        waiting: true,

        role,

        phase:
          room.phase,

        openInfo:
          room.openInfo,

        openReady:
          room.openReady,

        battleState:
          room.battleState
      });

    }

    /*
      両者確認完了
      → Battle開始
    */

    room.phase =
      "battle";

    initializeBattleState(
      room
    );

    touchRoomActivity(
      room
    );

    return res.json({
      success: true,

      waiting: false,

      role,

      phase:
        room.phase,

      openInfo:
        room.openInfo,

      openReady:
        room.openReady,

      battleState:
        room.battleState
    });

  }
);

/* =====================
   Battle（step1〜6）
===================== */

app.post(
  "/api/attack/place/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "battle"
    ) {

      return res.status(400).json({
        error: "Not battle phase",
        reason: "invalid_phase"
      });

    }

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    const bs =
      room.battleState;

    if (!bs) {

      return res.status(400).json({
        error:
          "Battle state not found",

        reason:
          "battle_state_not_found"
      });

    }

    /*
      Battle成功時の共通レスポンス
    */

    const sendBattleSuccess =
      () => {

        touchRoomActivity(
          room
        );

        return res.json({
          success: true,

          phase:
            room.phase,

          battleState:
            bs
        });

      };

    const cardIndex =
      Number(
        req.body?.cardIndex
      );

    const face =
      req.body?.face;

    const position =
      Number(
        req.body?.position
      );

    if (
      !Number.isInteger(
        cardIndex
      )
    ) {

      return res.status(400).json({
        error:
          "Invalid card index",

        reason:
          "invalid_card_index"
      });

    }

    if (
      face !== "表" &&
      face !== "伏せ"
    ) {

      return res.status(400).json({
        error: "Invalid face",
        reason: "invalid_face"
      });

    }

    if (
      !Number.isInteger(
        position
      ) ||
      position < 0 ||
      position > 5
    ) {

      return res.status(400).json({
        error:
          "Invalid position",

        reason:
          "invalid_position"
      });

    }

    const reverseFace =
      value =>
        value === "表"
          ? "伏せ"
          : "表";

    const place = (
      card,
      owner,
      faceValue,
      pos,
      placedBy =
        bs.currentRole
    ) => {

      if (
        pos < 0 ||
        pos >=
          bs.pointArea.length
      ) {

        throw new Error(
          "Invalid position"
        );

      }

      if (
        bs.pointArea[pos]
      ) {

        throw new Error(
          "Position filled"
        );

      }

      bs.pointArea[pos] = {
        card,
        owner,
        face: faceValue,
        placedBy
      };

    };

    try {

      /*
        共通手番確認
      */

      if (
        role !==
        bs.currentRole
      ) {

        return res.status(403).json({
          error: "Not your turn",
          reason: "not_your_turn"
        });

      }

      /* =====================
         step1
      ===================== */

      if (
        bs.step === 1
      ) {

        if (
          role !==
          "attack"
        ) {

          throw new Error(
            "Not your turn"
          );

        }

        if (
          position !== 0
        ) {

          throw new Error(
            "Must left"
          );

        }

        const card =
          bs.attackHand[
            cardIndex
          ];

        if (!card) {

          throw new Error(
            "Invalid card"
          );

        }

        place(
          card.value,
          "attack",
          face,
          0
        );

        bs.attackHand.splice(
          cardIndex,
          1
        );

        bs.forcedFace =
          reverseFace(
            face
          );

        bs.currentRole =
          "defense";

        bs.step =
          2;

        return sendBattleSuccess();

      }

      /* =====================
         step2
      ===================== */

      if (
        bs.step === 2
      ) {

        if (
          role !==
          "defense"
        ) {

          throw new Error(
            "Not your turn"
          );

        }

        if (
          face !==
          bs.forcedFace
        ) {

          throw new Error(
            "Forced"
          );

        }

        const card =
          bs.attackHand[
            cardIndex
          ];

        if (!card) {

          throw new Error(
            "Invalid card"
          );

        }

        place(
          card.value,
          "attack",
          face,
          position
        );

        bs.attackHand.splice(
          cardIndex,
          1
        );

        bs.forcedFace =
          null;

        bs.currentRole =
          "defense";

        bs.step =
          3;

        return sendBattleSuccess();

      }

      /* =====================
         step3
      ===================== */

      if (
        bs.step === 3
      ) {

        if (
          role !==
          "defense"
        ) {

          throw new Error(
            "Not your turn"
          );

        }

        const card =
          bs.defenseHand[
            cardIndex
          ];

        if (!card) {

          throw new Error(
            "Invalid card"
          );

        }

        place(
          card.value,
          "defense",
          face,
          position
        );

        bs.defenseHand.splice(
          cardIndex,
          1
        );

        bs.forcedFace =
          reverseFace(
            face
          );

        bs.currentRole =
          "attack";

        bs.step =
          4;

        return sendBattleSuccess();

      }

      /* =====================
         step4
      ===================== */

      if (
        bs.step === 4
      ) {

        if (
          role !==
          "attack"
        ) {

          throw new Error(
            "Not your turn"
          );

        }

        if (
          face !==
          bs.forcedFace
        ) {

          throw new Error(
            "Forced"
          );

        }

        const card =
          bs.defenseHand[
            cardIndex
          ];

        if (!card) {

          throw new Error(
            "Invalid card"
          );

        }

        place(
          card.value,
          "defense",
          face,
          position
        );

        bs.defenseHand.splice(
          cardIndex,
          1
        );

        bs.forcedFace =
          null;

        bs.currentRole =
          "attack";

        bs.step =
          5;

        return sendBattleSuccess();

      }

      /* =====================
         step5＋自動step6
      ===================== */

      if (
        bs.step === 5
      ) {

        if (
          role !==
          "attack"
        ) {

          throw new Error(
            "Not your turn"
          );

        }

        const combined = [
          ...bs.attackHand,
          ...bs.defenseHand
        ];

        const card =
          combined[
            cardIndex
          ];

        if (!card) {

          throw new Error(
            "Invalid card"
          );

        }

        place(
          card.value,
          card.owner,
          face,
          position
        );

        if (
          card.owner ===
          "attack"
        ) {

          bs.attackHand =
            bs.attackHand.filter(
              item =>
                item !== card
            );

        } else {

          bs.defenseHand =
            bs.defenseHand.filter(
              item =>
                item !== card
            );

        }

        const lastCard =
          bs.attackHand[0] ||
          bs.defenseHand[0];

        if (!lastCard) {

          throw new Error(
            "No card"
          );

        }

        const lastPosition =
          bs.pointArea.findIndex(
            point =>
              !point
          );

        if (
          lastPosition === -1
        ) {

          throw new Error(
            "No empty position"
          );

        }

        place(
          lastCard.value,
          lastCard.owner,
          "表",
          lastPosition,
          "defense"
        );

        bs.attackHand = [];
        bs.defenseHand = [];

        room.phase =
          "replace_attack";

        bs.currentRole =
          "attack";

        bs.forcedFace =
          null;

        return sendBattleSuccess();

      }

      return res.status(400).json({
        error:
          "Invalid battle step",

        reason:
          "invalid_battle_step"
      });

    } catch (error) {

      let reason =
        "battle_operation_failed";

      if (
        error.message ===
        "Not your turn"
      ) {

        reason =
          "not_your_turn";

      }

      if (
        error.message ===
        "Invalid card"
      ) {

        reason =
          "invalid_card";

      }

      if (
        error.message ===
        "Position filled"
      ) {

        reason =
          "position_filled";

      }

      if (
        error.message ===
        "Invalid position"
      ) {

        reason =
          "invalid_position";

      }

      if (
        error.message ===
        "Forced"
      ) {

        reason =
          "invalid_forced_face";

      }

      if (
        error.message ===
        "Must left"
      ) {

        reason =
          "step1_left_only";

      }

      if (
        error.message ===
        "No card"
      ) {

        reason =
          "remaining_card_not_found";

      }

      if (
        error.message ===
        "No empty position"
      ) {

        reason =
          "empty_position_not_found";

      }

      return res.status(400).json({
        error:
          error.message,

        reason
      });

    }

  }
);

/* =====================
   読み替え
===================== */

app.post(
  "/api/replace/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
        "replace_attack" &&
      room.phase !==
        "replace_defense"
    ) {

      return res.status(400).json({
        error: "Invalid phase",
        reason: "invalid_phase"
      });

    }

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    const index =
      Number(
        req.body?.index
      );

    const bs =
      room.battleState;

    if (!bs) {

      return res.status(400).json({
        error:
          "Battle state not found",

        reason:
          "battle_state_not_found"
      });

    }

    function hasOwnPlacedCard(
      battleState,
      startIndex,
      targetRole
    ) {

      for (
        let i = 0;
        i < 3;
        i++
      ) {

        const point =
          battleState
            .pointArea[
              startIndex + i
            ];

        if (
          point?.placedBy ===
          targetRole
        ) {

          return true;

        }

      }

      return false;

    }

    /* =====================
       Attack replace phase
    ===================== */

    if (
      room.phase ===
      "replace_attack"
    ) {

      if (
        role !==
        "attack"
      ) {

        return res.status(403).json({
          error: "Not your turn",
          reason: "not_your_turn"
        });

      }

      /*
        Attackがスキップ
      */

      if (
        index === -1
      ) {

        room.phase =
          "replace_defense";

        bs.currentRole =
          "defense";

        room.lastReplaceIndex =
          null;

        touchRoomActivity(
          room
        );

        return res.json({
          success: true,

          phase:
            room.phase,

          battleState:
            bs,

          lastReplaceIndex:
            room.lastReplaceIndex
        });

      }

      if (
        !Number.isInteger(
          index
        ) ||
        index < 0 ||
        index > 3
      ) {

        return res.status(400).json({
          error: "Invalid index",
          reason: "invalid_index"
        });

      }

      const binary =
        bs.pointArea
          .map(
            point =>
              point.card
          )
          .join("");

      if (
        binary.substr(
          index,
          3
        ) !== "000"
      ) {

        return res.status(400).json({
          error:
            "Invalid pattern",

          reason:
            "invalid_pattern"
        });

      }

      if (
        !hasOwnPlacedCard(
          bs,
          index,
          "attack"
        )
      ) {

        return res.status(400).json({
          error:
            "No own placed card",

          reason:
            "no_own_placed_card"
        });

      }

      for (
        let i = 0;
        i < 3;
        i++
      ) {

        bs.pointArea[
          index + i
        ].card =
          "1";

      }

      room.lastReplaceIndex =
        index;

      room.phase =
        "replace_defense";

      bs.currentRole =
        "defense";

      touchRoomActivity(
        room
      );

      return res.json({
        success: true,

        phase:
          room.phase,

        battleState:
          bs,

        lastReplaceIndex:
          room.lastReplaceIndex
      });

    }

    /* =====================
       Defense replace phase
    ===================== */

    if (
      room.phase ===
      "replace_defense"
    ) {

      if (
        role !==
        "defense"
      ) {

        return res.status(403).json({
          error: "Not your turn",
          reason: "not_your_turn"
        });

      }

      /*
        Defenseがスキップ
      */

      if (
        index === -1
      ) {

        bs.currentRole =
          null;

        room.lastReplaceIndex =
          null;

        /*
          finalizeRound内で
          touchRoomActivityが実行される
        */

        finalizeRound(
          room
        );

        return res.json({
          success: true,

          phase:
            room.phase,

          battleState:
            bs,

          lastReplaceIndex:
            null
        });

      }

      if (
        !Number.isInteger(
          index
        ) ||
        index < 0 ||
        index > 3
      ) {

        return res.status(400).json({
          error: "Invalid index",
          reason: "invalid_index"
        });

      }

      if (
        index ===
        room.lastReplaceIndex
      ) {

        return res.status(400).json({
          error:
            "Same position not allowed",

          reason:
            "same_position_not_allowed"
        });

      }

      const binary =
        bs.pointArea
          .map(
            point =>
              point.card
          )
          .join("");

      if (
        binary.substr(
          index,
          3
        ) !== "111"
      ) {

        return res.status(400).json({
          error:
            "Invalid pattern",

          reason:
            "invalid_pattern"
        });

      }

      if (
        !hasOwnPlacedCard(
          bs,
          index,
          "defense"
        )
      ) {

        return res.status(400).json({
          error:
            "No own placed card",

          reason:
            "no_own_placed_card"
        });

      }

      for (
        let i = 0;
        i < 3;
        i++
      ) {

        bs.pointArea[
          index + i
        ].card =
          "0";

      }

      bs.currentRole =
        null;

      room.lastReplaceIndex =
        null;

      /*
        finalizeRound内で
        touchRoomActivityが実行される
      */

      finalizeRound(
        room
      );

      return res.json({
        success: true,

        phase:
          room.phase,

        battleState:
          bs,

        lastReplaceIndex:
          null
      });

    }

    return res.status(400).json({
      error: "Invalid phase",
      reason: "invalid_phase"
    });

  }
);

/* =====================
   ラウンド終了
===================== */

function finalizeRound(
  room
) {

  ensureRoomLifecycle(
    room
  );

  const bs =
    room.battleState;

  if (
    !bs ||
    !Array.isArray(
      bs.pointArea
    )
  ) {

    throw new Error(
      "Battle state not found"
    );

  }

  const binary =
    bs.pointArea
      .map(point =>
        point.card
      )
      .join("");

  const score =
    parseInt(
      binary,
      2
    );

  /* =====================
     現在のAttackプレイヤーへ加算
  ===================== */

  const attackParticipant =
    room.roles.attack;

  room.totalScore[
    attackParticipant
  ] += score;

  room.finalBinary[
    attackParticipant
  ] =
    binary;

  bs.finalBinary =
    binary;

  bs.finalScore =
    score;

  bs.currentRole =
    null;

  room.lastReplaceIndex =
    null;

  /*
    実際にゲーム状態が進んだため、
    最終操作時刻を更新
  */

  touchRoomActivity(
    room
  );

  /* =====================
     Round1終了
  ===================== */

  if (
    room.round === 1
  ) {

    room.nextRoundReady = {
      attack: false,
      defense: false
    };

    /*
      まだ試合全体は終了していない
    */

    room.finalResultAt =
      null;

    room.closedAt =
      null;

    room.phase =
      "round_result";

    return;

  }

  /* =====================
     Round2終了
     → 最終結果
  ===================== */

  room.nextRoundReady =
    null;

  room.rematchState = {
    attack: null,
    defense: null
  };

  /*
    ランダムマッチ報酬を計算
  */

  applyRandomMatchReward(
    room
  );

  /*
    最終結果へ到達した正確な時刻を記録
  */

  room.finalResultAt =
    Date.now();

  /*
    まだ両者が離脱したわけではないため、
    closedAtは空にしておく
  */

  room.closedAt =
    null;

  room.phase =
    "final_result";

}

/* =====================
   次ラウンド準備
===================== */

app.post(
  "/api/next-round/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "round_result"
    ) {

      return res.status(400).json({
        error:
          "Not round result phase",

        reason:
          "invalid_phase"
      });

    }

    /*
      playerIdから本人と
      現在のRoleを判定
    */

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    const role =
      auth.access.role;

    if (
      !room.nextRoundReady
    ) {

      room.nextRoundReady = {
        attack: false,
        defense: false
      };

    }

    room.nextRoundReady[
      role
    ] = true;

    /*
      まだ片方だけ準備完了
    */

    if (
      !room.nextRoundReady.attack ||
      !room.nextRoundReady.defense
    ) {

      touchRoomActivity(
        room
      );

      return res.json({
        success: true,

        waiting: true,

        role,

        phase:
          room.phase,

        nextRoundReady:
          room.nextRoundReady
      });

    }

    /*
      両者準備完了
      → Round2へ進行
    */

    room.round =
      2;

    swapRoles(
      room
    );

    resetRoomForBuild(
      room
    );

    room.nextRoundReady =
      null;

    touchRoomActivity(
      room
    );

    return res.json({
      success: true,

      waiting: false,

      role,

      phase:
        room.phase,

      round:
        room.round,

      roles:
        room.roles,

      nextRoundReady:
        room.nextRoundReady
    });

  }
);

/* =====================
   最終結果後の選択
===================== */

app.post(
  "/api/match-end-choice/:roomId",
  (req, res) => {

    const room =
      rooms[req.params.roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    if (
      room.phase !==
      "final_result"
    ) {

      return res.status(400).json({
        error:
          "Not final result phase",

        reason:
          "invalid_phase"
      });

    }

    const auth =
      requireRoomPlayer(
        room,
        req.body
      );

    if (!auth.ok) {

      return res
        .status(auth.status)
        .json(auth.response);

    }

    /*
      再戦・終了状態は
      Participant固定スロットで管理
    */

    const participant =
      auth.access.participant;

    const action =
      req.body?.action;

    if (
      action !== "rematch" &&
      action !== "exit"
    ) {

      return res.status(400).json({
        error: "Invalid action",
        reason: "invalid_action"
      });

    }

    if (
      !room.rematchState
    ) {

      room.rematchState = {
        attack: null,
        defense: null
      };

    }

    const existingAction =
      room.rematchState[
        participant
      ];

    /*
      同じ選択の再送は成功扱い
    */

    if (
      existingAction ===
      action
    ) {

      return res.json({
        success: true,

        alreadySelected:
          true,

        action,

        participant,

        phase:
          room.phase,

        rematchState:
          room.rematchState,

        matchEnd: {

          attack:
            room.rematchState
              .attack,

          defense:
            room.rematchState
              .defense
        }
      });

    }

    /*
      一度選択したあとの
      選択変更は拒否
    */

    if (
      existingAction !== null &&
      existingAction !== undefined
    ) {

      return res.status(409).json({
        error:
          "Match end choice already selected",

        reason:
          "choice_already_selected"
      });

    }

    room.rematchState[
      participant
    ] =
      action;

    /*
      再戦・終了選択が保存されたため、
      Roomの最終操作時刻を更新
    */

    touchRoomActivity(
      room
    );

    const attackChoice =
      room.rematchState.attack;

    const defenseChoice =
      room.rematchState.defense;

    /*
      両者が再戦を選択
    */

    if (
      attackChoice ===
        "rematch" &&
      defenseChoice ===
        "rematch"
    ) {

      /*
        resetRoomForRematch内でも
        touchRoomActivityが実行される
      */

      resetRoomForRematch(
        room
      );

      return res.json({
        success: true,

        alreadySelected:
          false,

        rematchStarted:
          true,

        action,

        participant,

        phase:
          room.phase,

        round:
          room.round,

        roles:
          room.roles,

        rematchState:
          room.rematchState,

        matchEnd: {
          attack: null,
          defense: null
        }
      });

    }

    /*
      相手の選択待ち、
      またはどちらかが終了を選択
    */

    return res.json({
      success: true,

      alreadySelected:
        false,

      rematchStarted:
        false,

      action,

      participant,

      phase:
        room.phase,

      rematchState:
        room.rematchState,

      matchEnd: {

        attack:
          room.rematchState
            .attack,

        defense:
          room.rematchState
            .defense
      }
    });

  }
);

/* =====================
   報酬確認API
   POST /api/reward-claim-info/:roomId
===================== */

app.post(
  "/api/reward-claim-info/:roomId",
  requireWixBackend,
  (req, res) => {

    cleanupRooms();

    const roomId =
      req.params.roomId;

    const room =
      rooms[roomId];

    if (!room) {

      return res.status(404).json({
        error: "Room not found",
        reason: "room_not_found"
      });

    }

    const playerId =
      typeof req.body?.playerId === "string"
        ? req.body.playerId.trim()
        : "";

    if (!playerId) {

      return res.status(400).json({
        error: "playerId is required",
        reason: "missing_player_id"
      });

    }

    const participantInfo =
      getParticipantByPlayerId(
        room,
        playerId
      );

    if (!participantInfo) {

      return res.status(403).json({
        error:
          "Player is not in this room",

        reason:
          "player_not_in_room"
      });

    }

    /*
      報酬はランダムマッチのみ
    */

    if (room.type !== "random") {

      return res.json({
        eligible: false,
        reason: "not_random_match"
      });

    }

    /*
      同一アカウント同士のRoomでは
      報酬請求を拒否
    */

    if (
      room.participants.attack.memberId &&
      room.participants.attack.memberId ===
      room.participants.defense.memberId
    ) {

      return res.json({
        eligible: false,
        reason: "same_member_id"
      });

    }

    /*
      最終結果へ到達していなければ、
      報酬はまだ確定していない
    */

    if (
      room.phase !==
      "final_result"
    ) {

      return res.json({
        eligible: false,
        reason: "match_not_finished"
      });

    }

    const participant =
      participantInfo.participant;

    const participantData =
      participantInfo.data;

    /*
      Wix DataのAccountへ
      紐づけるmemberIdが必要
    */

    if (
      !participantData.memberId
    ) {

      return res.json({
        eligible: false,
        reason: "missing_member_id"
      });

    }

    const reward =
      createParticipantReward(
        roomId,
        room,
        participant
      );

    if (!reward.eligible) {

      return res.json(
        reward
      );

    }

    return res.json({
      ...reward,

      /*
        Wixバックエンド側で、
        ログイン中の本人IDと照合する
      */

      memberId:
        participantData.memberId
    });

  }
);

/* =====================
   定期クリーンアップ
===================== */

const cleanupTimer =
  setInterval(
    () => {

      try {

        cleanupRandomTickets();

        cleanupRooms();

      } catch (error) {

        console.error(
          "Cleanup failed:",
          error
        );

      }

    },
    ROOM_CLEANUP_INTERVAL_MS
  );

/*
  Node.js終了時に、
  このTimerだけがプロセスを
  生存させ続けないようにする
*/

if (
  typeof cleanupTimer.unref ===
  "function"
) {

  cleanupTimer.unref();

}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});

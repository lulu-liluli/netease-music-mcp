import {
  bearerAuthChallengeResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  controlPlayback,
  getClientStatus,
  getListenTogetherCapabilities,
  getLyrics,
  getSongDetails,
  launchClient,
  nextTrackDirect,
  openClientArea,
  openEntity,
  openListenTogetherInvite,
  searchSongs,
} from './netease.js';
import {
  addSongsToPlaylist,
  createPlaylist,
  getPlaylistAuthStatus,
  listOwnPlaylists,
  removeSongsFromPlaylist,
} from './playlist.js';

function success(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function failure(error) {
  return {
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

function oauthSecuritySchemes(scopes) {
  return [{ type: 'oauth2', scopes }];
}

function insufficientScopeFailure(scope, resourceMetadataUrl) {
  const requiredScopes = [...new Set(['music:read', scope])];
  const response = bearerAuthChallengeResponse(
    new OAuthError(
      OAuthErrorCode.InsufficientScope,
      `Required scope missing: ${scope}`,
    ),
    { requiredScopes, resourceMetadataUrl },
  );
  const challenge = response.headers.get('www-authenticate');

  return {
    content: [
      {
        type: 'text',
        text: `当前 Token 缺少 ${scope} 权限。`,
      },
    ],
    isError: true,
    _meta: {
      'mcp/www_authenticate': [challenge],
    },
  };
}

async function handle(operation) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

const KUGOU_EVENT_ERRORS = {
  invalid_params: '等待工具参数无效。',
  insufficient_scope: '当前 Token 缺少 music:read 权限。',
  waiter_busy: '已有酷狗事件等待请求，请在其结束后重试。',
  cancelled: '酷狗事件等待已取消。',
  signal_unavailable: '请求取消信号不可用。',
  stale_reservation: '事件预留凭据已失效。',
  reservation_required: '确认事件需要完整预留凭据。',
  unknown_event: '事件不存在或已过期。',
  invalid_state: '事件当前无法确认。',
  internal_error: '酷狗事件操作失败。',
};
const kugouEventErrorSchema = z.object({
  outcome: z.literal('error'),
  error: z.object({
    code: z.enum(Object.keys(KUGOU_EVENT_ERRORS)),
    message: z.string(),
  }),
});
const kugouTrackSchema = z.object({
  title: z.string(),
  artist: z.string(),
  album: z.string(),
});
const kugouEventFields = {
  id: z.string(),
  device: z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    deviceType: z.string(),
  }),
  createdAt: z.string(),
  observedAt: z.string(),
};
// Zod object parsing allowlists fields at every level, including track metadata.
const publicKugouEventSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...kugouEventFields,
    eventType: z.literal('track_changed'),
    previous: z.object({ track: kugouTrackSchema }),
    current: z.object({ track: kugouTrackSchema }),
  }),
  ...['playback_paused', 'playback_resumed'].map((eventType) => z.object({
    ...kugouEventFields,
    eventType: z.literal(eventType),
    previous: z.object({ playbackState: z.enum(['playing', 'paused']) }),
    current: z.object({ playbackState: z.enum(['playing', 'paused']) }),
  })),
]);

function kugouEventResult(data, text, isError = false) {
  return {
    structuredContent: data,
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function kugouEventFailure(code) {
  const message = KUGOU_EVENT_ERRORS[code];
  return kugouEventResult(
    { outcome: 'error', error: { code, message } },
    `${code}: ${message}`,
    true,
  );
}

function structuredInputSchema(schema) {
  // The SDK otherwise turns validation failures into text-only errors. Preserve
  // its real Standard Schema JSON contract and pass an invalid sentinel so the
  // handler can return a sanitized structured error without echoing input.
  return {
    '~standard': {
      ...schema['~standard'],
      validate(value) {
        const parsed = schema.safeParse(value);
        return { value: parsed.success ? parsed.data : null };
      },
    },
  };
}

export function createNeteaseMcpServer({
  authInfo,
  accountContext,
  kugouBridge,
  kugouEventQueue,
  resourceMetadataUrl,
} = {}) {
  const accountOptions = accountContext
    ? {
        sessionProvider: accountContext.loadNeteaseSession,
        sessionConfigurationProvider: accountContext.getSessionConfiguration,
      }
    : {};
  const guarded = (scope, operation) => {
    if (authInfo && !authInfo.scopes.includes(scope)) {
      return insufficientScopeFailure(scope, resourceMetadataUrl);
    }
    return handle(operation);
  };
  const guardedEvent = async (operation) => {
    if (authInfo && !authInfo.scopes.includes('music:read')) {
      const denied = insufficientScopeFailure('music:read', resourceMetadataUrl);
      return { ...kugouEventFailure('insufficient_scope'), _meta: denied._meta };
    }
    try {
      return await operation();
    } catch (error) {
      return kugouEventFailure(
        error?.code === 'waiter_busy'
          ? 'waiter_busy'
          : error?.name === 'AbortError' ? 'cancelled' : 'internal_error',
      );
    }
  };
  const server = new McpServer(
    {
      name: 'netease-music-mcp',
      version: '0.5.0',
    },
    {
      instructions:
        '跨平台网易云音乐 MCP。搜索、详情、歌词和歌单账号能力可在桌面、服务器或移动 MCP 客户端使用；本地播放器控制取决于设备适配器。打开页面或控制播放前应获得用户明确意图。歌单写工具只能在用户明确确认本次修改后调用，并必须传 confirm=true。不得用于下载音频、绕过会员或版权限制。',
    },
  );

  server.registerTool(
    'netease_playlist_auth_status',
    {
      title: '网易云歌单账号能力状态',
      description: '只检查账号写入功能是否已启用、是否配置会话文件；不返回任何 Cookie 值。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guarded('playlist:read', () => getPlaylistAuthStatus(accountOptions)),
  );

  server.registerTool(
    'netease_playlist_list',
    {
      title: '列出我创建的网易云歌单',
      description: '使用本机登录会话列出当前账号拥有的歌单，供后续添加或移除歌曲。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guarded('playlist:read', () => listOwnPlaylists(accountOptions)),
  );

  server.registerTool(
    'netease_playlist_create',
    {
      title: '创建网易云歌单',
      description: '在当前登录账号下创建公开或隐私歌单。必须在用户明确确认本次创建后调用。',
      inputSchema: z.object({
        name: z.string().min(1).max(40),
        isPrivate: z.boolean().default(false),
        confirm: z.literal(true).describe('用户已明确确认创建这个歌单'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, isPrivate }) =>
      guarded('playlist:write', () => createPlaylist(name, isPrivate, accountOptions)),
  );

  server.registerTool(
    'netease_playlist_add_songs',
    {
      title: '添加歌曲到网易云歌单',
      description: '将 1–100 首歌曲加入当前账号拥有的指定歌单；修改前会再次校验歌单归属。',
      inputSchema: z.object({
        playlistId: z.string().regex(/^\d{1,20}$/),
        songIds: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(100),
        confirm: z.literal(true).describe('用户已明确确认添加这些歌曲'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ playlistId, songIds }) =>
      guarded('playlist:write', () =>
        addSongsToPlaylist(playlistId, songIds, accountOptions),
      ),
  );

  server.registerTool(
    'netease_playlist_remove_songs',
    {
      title: '从网易云歌单移除歌曲',
      description: '从当前账号拥有的指定歌单移除 1–100 首歌曲；必须明确确认，且会校验歌单归属。',
      inputSchema: z.object({
        playlistId: z.string().regex(/^\d{1,20}$/),
        songIds: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(100),
        confirm: z.literal(true).describe('用户已明确确认移除这些歌曲'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ playlistId, songIds }) =>
      guarded('playlist:write', () =>
        removeSongsFromPlaylist(playlistId, songIds, accountOptions),
      ),
  );

  server.registerTool(
    'netease_status',
    {
      title: '网易云客户端状态',
      description: '检查当前运行平台、远程能力和可用的本地播放器适配器；macOS 还会读取客户端状态。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guarded('music:read', getClientStatus),
  );

  if (kugouBridge) {
    server.registerTool(
      'kugou_status',
      {
        title: '读取当前活动酷狗设备状态',
        description:
          '读取当前活动酷狗设备最近上报的播放状态；离线或过期状态会明确标记。',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: {
          securitySchemes: oauthSecuritySchemes(['music:read']),
        },
      },
      async () => guarded('music:read', () => kugouBridge.getStatus()),
    );

    server.registerTool(
      'kugou_control',
      {
        title: '控制当前活动酷狗设备播放',
        description:
          '向当前活动酷狗设备排队发送播放/暂停、下一首或上一首命令。设备离线、异常或控制未启用时不会创建命令。',
        inputSchema: z.object({
          action: z.enum(['toggle', 'next', 'previous']),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          securitySchemes: oauthSecuritySchemes([
            'music:read',
            'player:control',
          ]),
        },
      },
      async ({ action }) =>
        guarded('player:control', () => kugouBridge.enqueueCommand(action)),
    );

    if (kugouEventQueue) {
      server.registerTool(
        'kugou_wait',
        {
          title: '等待当前活动酷狗设备事件',
          description:
            '等待并预留一条当前活动设备事件；超时为正常结果。处理事件后需用事件 id 和完整 receiptToken 调用 kugou_wait_ack；本工具不会自动确认事件。',
          inputSchema: structuredInputSchema(z.strictObject({
            timeout_ms: z.number().int().min(1).max(45_000).default(30_000),
          })),
          outputSchema: z.discriminatedUnion('outcome', [
            z.object({
              outcome: z.literal('event'),
              event: publicKugouEventSchema,
              reservation: z.object({
                receiptToken: z.string(),
                leaseExpiresAt: z.number(),
              }),
            }),
            z.object({ outcome: z.literal('timeout') }),
            kugouEventErrorSchema,
          ]),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
          _meta: { securitySchemes: oauthSecuritySchemes(['music:read']) },
        },
        async (args, ctx) => {
          const deviceId = kugouBridge.activeDeviceId;
          return guardedEvent(async () => {
            if (args === null) return kugouEventFailure('invalid_params');
            const signal = ctx.mcpReq.signal;
            if (!signal) return kugouEventFailure('signal_unavailable');
            const reservation = await kugouEventQueue.waitNext({
              deviceId,
              timeoutMs: args.timeout_ms,
              signal,
            });
            if (signal.aborted) {
              if (reservation) {
                kugouEventQueue.release(reservation.event.id, reservation.receiptToken);
              }
              return kugouEventFailure('cancelled');
            }
            if (!reservation) {
              return kugouEventResult({ outcome: 'timeout' }, '等待超时，暂无酷狗事件。');
            }
            return kugouEventResult({
              outcome: 'event',
              event: publicKugouEventSchema.parse(reservation.event),
              reservation: {
                receiptToken: reservation.receiptToken,
                leaseExpiresAt: reservation.leaseExpiresAt,
              },
            }, '已预留酷狗事件，请处理后使用完整 receiptToken 确认。');
          });
        },
      );

      server.registerTool(
        'kugou_wait_ack',
        {
          title: '确认已处理的酷狗事件',
          description: '使用事件 id 和完整 receiptToken 确认事件；不会控制设备播放。',
          inputSchema: structuredInputSchema(z.strictObject({
            eventId: z.string().min(1).max(256),
            receiptToken: z.string().max(256),
          })),
          outputSchema: z.discriminatedUnion('outcome', [
            z.object({
              outcome: z.literal('acknowledged'),
              eventId: z.string(),
              acknowledged: z.literal(true),
              alreadyAcknowledged: z.boolean(),
            }),
            kugouEventErrorSchema,
          ]),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: { securitySchemes: oauthSecuritySchemes(['music:read']) },
        },
        async (args) => guardedEvent(() => {
          if (args === null) return kugouEventFailure('invalid_params');
          const result = kugouEventQueue.ack(args.eventId, args.receiptToken);
          if (!result.acknowledged) {
            const code = ['stale_reservation', 'reservation_required', 'unknown_event', 'invalid_state']
              .includes(result.reason) ? result.reason : 'internal_error';
            return kugouEventFailure(code);
          }
          return kugouEventResult({
            outcome: 'acknowledged',
            eventId: args.eventId,
            acknowledged: true,
            alreadyAcknowledged: result.alreadyAcknowledged,
          }, result.alreadyAcknowledged ? '事件已确认，无需重复处理。' : '事件确认成功。');
        }),
      );
    }
  }

  server.registerTool(
    'netease_search',
    {
      title: '搜索网易云歌曲',
      description: '通过 music.163.com 的匿名只读接口搜索歌曲，不读取账号 Cookie。',
      inputSchema: z.object({
        query: z.string().min(1).max(100).describe('歌曲、歌手或关键词'),
        limit: z.number().int().min(1).max(20).default(10),
        offset: z.number().int().min(0).max(10_000).default(0),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, offset }) =>
      guarded('music:read', () => searchSongs(query, limit, offset)),
  );

  server.registerTool(
    'netease_song_detail',
    {
      title: '读取网易云歌曲详情',
      description: '按网易云歌曲 ID 读取名称、歌手、专辑、时长和官方页面链接。',
      inputSchema: z.object({
        songIds: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ songIds }) => guarded('music:read', () => getSongDetails(songIds)),
  );

  server.registerTool(
    'netease_lyrics',
    {
      title: '读取网易云歌词',
      description: '按歌曲 ID 读取 LRC、翻译和罗马音歌词；不下载音频。',
      inputSchema: z.object({
        songId: z.string().regex(/^\d{1,20}$/),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ songId }) => guarded('music:read', () => getLyrics(songId)),
  );

  server.registerTool(
    'netease_launch',
    {
      title: '启动网易云音乐（macOS）',
      description: '通过 macOS 适配器启动已安装的官方网易云音乐客户端；其他平台会返回清晰的能力错误。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => guarded('player:control', launchClient),
  );

  server.registerTool(
    'netease_open_entity',
    {
      title: '在网易云打开资源',
      description: '通过 macOS 适配器在官方客户端中打开歌曲、歌单、专辑或歌手页面。',
      inputSchema: z.object({
        type: z.enum(['song', 'playlist', 'album', 'artist']),
        id: z.string().regex(/^\d{1,20}$/),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ type, id }) =>
      guarded('player:control', () => openEntity(type, id)),
  );

  server.registerTool(
    'netease_open_area',
    {
      title: '打开网易云功能页',
      description: '打开私人 FM、下载管理或听歌识曲。只允许预设的 orpheus:// 路由。',
      inputSchema: z.object({
        area: z.enum(['private_fm', 'downloads', 'recognize']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ area }) => guarded('player:control', () => openClientArea(area)),
  );

  server.registerTool(
    'netease_listen_together_capabilities',
    {
      title: '检查一起听能力',
      description:
        '检查当前设备的一起听能力。macOS 适配器可打开邀请；互动能力取决于网易云官方移动端。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guarded('player:control', getListenTogetherCapabilities),
  );

  server.registerTool(
    'netease_listen_together_invite',
    {
      title: '邀请好友一起听',
      description:
        '通过 macOS 适配器打开“一起听”邀请界面。调用前必须确认用户明确希望发起邀请；好友或分享方式由用户在客户端中选择。',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => guarded('player:control', openListenTogetherInvite),
  );

  server.registerTool(
    'netease_next_track',
    {
      title: '普通播放下一首',
      description:
        '让 macOS 直接向当前网易云播放器发送下一首命令。仅用于普通播放，不操控屏幕，也不用于一起听房间。',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => guarded('player:control', nextTrackDirect),
  );

  server.registerTool(
    'netease_control',
    {
      title: '控制网易云播放',
      description: '控制官方 Mac 客户端播放/暂停、上一首或下一首，需要 macOS 辅助功能权限。',
      inputSchema: z.object({
        action: z.enum(['play_pause', 'previous', 'next']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ action }) => guarded('player:control', () => controlPlayback(action)),
  );

  return server;
}

import WebSocket from "ws";
import path from "node:path";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize, DEFAULT_IMAGE_SIZE } from "./utils/image-size.js";

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
};

// 权限级别：从高到低依次尝试
const INTENT_LEVELS = [
  // Level 0: 完整权限（群聊 + 私信 + 频道）
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  // Level 1: 群聊 + 频道（无私信）
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  // Level 2: 仅频道（基础权限）
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || path.join(process.env.HOME || "/home/ubuntu", "clawd", "qqbot-images");

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度
const MESSAGE_QUEUE_WARN_THRESHOLD = 800; // 队列告警阈值

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过1小时需降级为主动消息
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns { allowed: boolean, remaining: number } allowed=是否允许回复，remaining=剩余次数
 */
function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否过期
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否超过限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
}

// ============ 图片发送时的文本智能简化 ============
// 当 AI 发送图片时，检测并移除冗余的解释性文字

/**
 * 冗余文本模式 - 这些模式表示 AI 在"解释"而不是"回应"
 * 通常出现在 AI 不确定图片是否发送成功时
 */
const REDUNDANT_TEXT_PATTERNS = [
  // 中文冗余模式
  /让我总结一下[^\n]*/gi,
  /目前的情况[是：:][^\n]*/gi,
  /由于[^\n]*(?:工具[集]?|插件|集成|API)[^\n]*(?:限制|问题)[^\n]*/gi,
  /我已经[^\n]*(?:尝试|下载|保存)[^\n]*/gi,
  /最实用的(?:方法|解决方案)[是：:][^\n]*/gi,
  /如果你希望我继续[^\n]*/gi,
  /你可以[直接]?点击[^\n]*链接[^\n]*/gi,
  /我注意到你重复[^\n]*/gi,
  /我[已经]?多次尝试[^\n]*/gi,
  /(?:已经|成功)?(?:保存|下载)到本地[^\n]*/gi,
  /(?:直接)?(?:查看|访问)[该这]?(?:图片|文件|链接)[^\n]*/gi,
  // 英文冗余模式
  /let me summarize[^\n]*/gi,
  /i(?:'ve| have) tried[^\n]*(?:multiple|several)[^\n]*/gi,
  /due to[^\n]*(?:tool|plugin|integration)[^\n]*limitation[^\n]*/gi,
  /the most practical[^\n]*solution[^\n]*/gi,
];

/**
 * 检查文本是否为纯冗余解释
 * 如果整个文本都是在解释发送过程，而不是描述图片内容，则返回 true
 */
function isEntirelyRedundantExplanation(text: string): boolean {
  // 移除空行和空格
  const trimmed = text.trim();
  if (!trimmed) return true;
  
  // 检查是否包含"步骤列表"类的解释
  const hasStepList = /^\d+\.\s+/m.test(trimmed) && 
                      (trimmed.includes("下载") || trimmed.includes("尝试") || trimmed.includes("发送"));
  
  // 检查是否主要由冗余模式组成
  let cleaned = trimmed;
  for (const pattern of REDUNDANT_TEXT_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  
  // 如果清理后只剩下很少的文字（主要是标点和连接词），认为整体都是冗余
  const cleanedWords = cleaned.replace(/[\s\n\r.,;:!?，。；：！？·…—""''()（）【】[\]{}]+/g, "").trim();
  const significantContentRemaining = cleanedWords.length > 20;
  
  return hasStepList || !significantContentRemaining;
}

/**
 * 智能简化图片发送时的文本
 * 当检测到发送图片时，移除冗余的解释性文字
 * 
 * @param text 原始文本
 * @param hasImages 是否包含图片
 * @returns 简化后的文本
 */
function simplifyTextForImageSend(text: string, hasImages: boolean): string {
  if (!hasImages || !text) return text;
  
  const trimmed = text.trim();
  
  // 如果整个文本都是冗余解释，替换为简短的成功提示
  if (isEntirelyRedundantExplanation(trimmed)) {
    return "图片如上 ☝️";
  }
  
  // 否则，只移除明显的冗余段落
  let result = trimmed;
  for (const pattern of REDUNDANT_TEXT_PATTERNS) {
    result = result.replace(pattern, "");
  }
  
  // 清理多余的空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  
  // 如果清理后文本太短，恢复原文
  if (result.length < 10 && trimmed.length > 50) {
    return "图片如上 ☝️";
  }
  
  return result || trimmed;
}

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  let intentLevelIndex = 0; // 当前尝试的权限级别索引
  let lastSuccessfulIntentLevel = -1; // 上次成功的权限级别

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  const savedSession = loadSession(account.accountId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 消息队列（异步处理，防止阻塞心跳） ============
  const messageQueue: QueuedMessage[] = [];
  let messageProcessorRunning = false;
  let messagesProcessed = 0; // 统计已处理消息数

  /**
   * 将消息加入队列（非阻塞）
   */
  const enqueueMessage = (msg: QueuedMessage): void => {
    if (messageQueue.length >= MESSAGE_QUEUE_SIZE) {
      // 队列满了，丢弃最旧的消息
      const dropped = messageQueue.shift();
      log?.error(`[qqbot:${account.accountId}] Message queue full, dropping oldest message from ${dropped?.senderId}`);
    }
    if (messageQueue.length >= MESSAGE_QUEUE_WARN_THRESHOLD) {
      log?.info(`[qqbot:${account.accountId}] Message queue size: ${messageQueue.length}/${MESSAGE_QUEUE_SIZE}`);
    }
    messageQueue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued, queue size: ${messageQueue.length}`);
  };

  /**
   * 启动消息处理循环（独立于 WS 消息循环）
   */
  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    if (messageProcessorRunning) return;
    messageProcessorRunning = true;

    const processLoop = async () => {
      while (!isAborted) {
        if (messageQueue.length === 0) {
          // 队列为空，等待一小段时间
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        const msg = messageQueue.shift()!;
        try {
          await handleMessageFn(msg);
          messagesProcessed++;
        } catch (err) {
          // 捕获处理异常，防止影响队列循环
          log?.error(`[qqbot:${account.accountId}] Message processor error: ${err}`);
        }
      }
      messageProcessorRunning = false;
      log?.info(`[qqbot:${account.accountId}] Message processor stopped`);
    };

    // 异步启动，不阻塞调用者
    processLoop().catch(err => {
      log?.error(`[qqbot:${account.accountId}] Message processor crashed: ${err}`);
      messageProcessorRunning = false;
    });

    log?.info(`[qqbot:${account.accountId}] Message processor started`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh();
    // P1-3: 保存已知用户数据
    flushKnownUsers();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache();
        shouldRefreshToken = false;
      }
      
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string }>;
      }) => {
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        const isGroup = event.type === "guild" || event.type === "group";
        const peerId = event.type === "guild" ? `channel:${event.channelId}` 
                     : event.type === "group" ? `group:${event.groupOpenid}`
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroup ? "group" : "dm",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体，添加系统提示词
        let builtinPrompt = "";
        
        // ============ 用户标识信息（用于定时提醒和主动消息） ============
        const isGroupChat = event.type === "group";
        const targetAddress = isGroupChat ? `group:${event.groupOpenid}` : event.senderId;
        
        builtinPrompt += `
【当前用户信息】
- 用户 openid: ${event.senderId}
- 用户昵称: ${event.senderName || "未知"}
- 消息类型: ${isGroupChat ? "群聊" : "私聊"}
- 当前消息 message_id: ${event.messageId}${isGroupChat ? `
- 群组 group_openid: ${event.groupOpenid}` : ""}

【定时提醒能力】
你可以帮助用户设置定时提醒。使用 openclaw cron 命令：

示例：5分钟后提醒用户喝水
\`\`\`bash
openclaw cron add \\
  --name "提醒喝水-${event.senderName || "用户"}" \\
  --at "5m" \\
  --session isolated \\
  --message "💧 该喝水啦！" \\
  --deliver \\
  --channel qqbot \\
  --to "${targetAddress}" \\
  --reply-to "${event.messageId}" \\
  --delete-after-run
\`\`\`

关键参数说明：
- \`--to\`: 目标地址（当前用户: ${targetAddress}）
- \`--reply-to\`: 回复消息ID（当前消息: ${event.messageId}，使提醒能引用原消息）
- \`--at\`: 一次性定时任务的触发时间
  - 相对时间格式：数字+单位，如 \`5m\`（5分钟）、\`1h\`（1小时）、\`2d\`（2天）【注意：不要加 + 号】
  - 绝对时间格式：ISO 8601 带时区，如 \`2026-02-01T14:00:00+08:00\`
- \`--cron\`: 周期性任务（如 \`0 8 * * *\` 每天早上8点）
- \`--tz "Asia/Shanghai"\`: 周期任务务必设置时区
- \`--delete-after-run\`: 一次性任务必须添加此参数
- \`--message\`: 消息内容（必填，不能为空！对应 QQ API 的 markdown.content 字段）

⚠️ 重要注意事项：
1. --at 参数格式：相对时间用 \`5m\`、\`1h\` 等（不要加 + 号！）；绝对时间用完整 ISO 格式
2. --message 参数必须有实际内容，不能为空字符串`;

        // 只有配置了图床公网地址，才告诉 AI 可以发送图片
        if (imageServerBaseUrl) {
          builtinPrompt += `

【发送图片】
你可以发送本地图片文件给用户。只需在回复中直接引用图片的绝对路径即可，系统会自动处理。
支持 png、jpg、gif、webp 格式。`;
        }
        
        const systemPrompts = [builtinPrompt];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        // 存到 clawdbot 工作目录下的 downloads 文件夹
        const downloadDir = path.join(process.env.HOME || "/home/ubuntu", "clawd", "downloads");
        
        if (event.attachments?.length) {
          for (const att of event.attachments) {
            // 下载附件到本地，使用原始文件名
            const localPath = await downloadFile(att.url, downloadDir, att.filename);
            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                attachmentInfo += `\n[图片: ${localPath}]`;
              } else {
                attachmentInfo += `\n[附件: ${localPath}]`;
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，提供原始 URL 作为后备
              log?.error(`[qqbot:${account.accountId}] Failed to download attachment: ${att.url}`);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(att.url);
                attachmentInfo += `\n[图片: ${att.url}] (下载失败，可能无法访问)`;
              } else {
                attachmentInfo += `\n[附件: ${att.filename ?? att.content_type}] (下载失败)`;
              }
            }
          }
        }
        
        const userContent = event.content + attachmentInfo;
        const messageBody = `【系统提示】\n${systemPrompts.join("\n")}\n\n【用户输入】\n${userContent}`;

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "QQBot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: messageBody,
          chatType: isGroup ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          // 传递图片 URL 列表
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                         : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                         : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroup ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
        });

        // 发送消息的辅助函数，带 token 过期重试
        const sendWithTokenRetry = async (sendFn: (token: string) => Promise<unknown>) => {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendFn(token);
          } catch (err) {
            const errMsg = String(err);
            // 如果是 token 相关错误，清除缓存重试一次
            if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
              log?.info(`[qqbot:${account.accountId}] Token may be expired, refreshing...`);
              clearTokenCache();
              const newToken = await getAccessToken(account.appId, account.clientSecret);
              await sendFn(newToken);
            } else {
              throw err;
            }
          }
        };

        // 发送错误提示的辅助函数
        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendWithTokenRetry(async (token) => {
              if (event.type === "c2c") {
                await sendC2CMessage(token, event.senderId, errorText, event.messageId);
              } else if (event.type === "group" && event.groupOpenid) {
                await sendGroupMessage(token, event.groupOpenid, errorText, event.messageId);
              } else if (event.channelId) {
                await sendChannelMessage(token, event.channelId, errorText, event.messageId);
              }
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          const responseTimeout = 60000; // 60秒超时（1分钟）
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          // ============ 消息发送目标 ============
          // 确定发送目标
          const targetTo = event.type === "c2c" ? event.senderId
                        : event.type === "group" ? `group:${event.groupOpenid}`
                        : `channel:${event.channelId}`;

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                let replyText = payload.text ?? "";
                
                // 收集所有图片（公网 URL 或 Base64 Data URL）
                // 注意：本地文件路径由 OpenClaw 负责转换（通过对象存储上传或读取为 Base64）
                const imageUrls: string[] = [];
                
                /**
                 * 检查并收集图片 URL
                 * 支持：公网 URL (http/https) 和 Base64 Data URL (data:image/...)
                 */
                const collectImageUrl = (url: string | undefined | null): boolean => {
                  if (!url) return false;
                  
                  const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
                  const isDataUrl = url.startsWith("data:image/");
                  
                  if (isHttpUrl || isDataUrl) {
                    if (!imageUrls.includes(url)) {
                      imageUrls.push(url);
                      if (isDataUrl) {
                        log?.info(`[qqbot:${account.accountId}] Collected Base64 image (length: ${url.length})`);
                      } else {
                        log?.info(`[qqbot:${account.accountId}] Collected media URL: ${url.slice(0, 80)}...`);
                      }
                    }
                    return true;
                  }
                  
                  // 检测本地文件路径
                  const isLocalPath = url.startsWith("/") || 
                                      /^[a-zA-Z]:[\\/]/.test(url) ||
                                      url.startsWith("./") ||
                                      url.startsWith("../");
                  
                  if (isLocalPath) {
                    log?.info(`[qqbot:${account.accountId}] Skipped local file path (OpenClaw should convert to Base64 or upload): ${url.slice(0, 80)}`);
                  } else {
                    log?.info(`[qqbot:${account.accountId}] Skipped unsupported media format: ${url.slice(0, 50)}`);
                  }
                  return false;
                };
                
                // 处理 mediaUrls 和 mediaUrl 字段
                if (payload.mediaUrls?.length) {
                  for (const url of payload.mediaUrls) {
                    collectImageUrl(url);
                  }
                }
                if (payload.mediaUrl) {
                  collectImageUrl(payload.mediaUrl);
                }
                
                // 提取文本中的图片格式
                // 1. 提取 markdown 格式的图片 ![alt](url) 或 ![#宽px #高px](url)
                const mdImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
                const mdMatches = [...replyText.matchAll(mdImageRegex)];
                for (const match of mdMatches) {
                  const url = match[2];
                  if (url && !imageUrls.includes(url)) {
                    imageUrls.push(url);
                    log?.info(`[qqbot:${account.accountId}] Extracted image from markdown: ${url.slice(0, 80)}...`);
                  }
                }
                
                // 2. 提取裸 URL 图片（仅在非 markdown 模式下移除）
                const bareUrlRegex = /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
                const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
                for (const match of bareUrlMatches) {
                  const url = match[1];
                  if (url && !imageUrls.includes(url)) {
                    imageUrls.push(url);
                    log?.info(`[qqbot:${account.accountId}] Extracted bare image URL: ${url.slice(0, 80)}...`);
                  }
                }
                
                // 判断是否使用 markdown 模式
                const useMarkdown = account.markdownSupport === true;
                log?.info(`[qqbot:${account.accountId}] Markdown mode: ${useMarkdown}, images: ${imageUrls.length}`);
                
                let textWithoutImages = replyText;
                
                // 🎯 智能简化文本：当发送图片时，移除冗余的解释性文字
                // 这解决了 AI 不确定图片是否发送成功而输出大量废话的问题
                if (imageUrls.length > 0) {
                  const originalLength = textWithoutImages.length;
                  textWithoutImages = simplifyTextForImageSend(textWithoutImages, true);
                  if (textWithoutImages.length !== originalLength) {
                    log?.info(`[qqbot:${account.accountId}] Simplified text for image send: ${originalLength} -> ${textWithoutImages.length} chars`);
                  }
                }
                
                // 根据模式处理图片
                if (useMarkdown) {
                  // ============ Markdown 模式：使用 ![#宽px #高px](url) 格式 ============
                  // QQBot 的 markdown 图片格式要求：![#宽px #高px](url)
                  // 需要自动获取图片尺寸，或使用默认尺寸
                  
                  // 记录已存在于文本中的 markdown 图片 URL
                  const existingMdUrls = new Set(mdMatches.map(m => m[2]));
                  
                  // 需要追加的图片（从 mediaUrl/mediaUrls 来的）
                  const imagesToAppend: string[] = [];
                  
                  // 处理需要追加的图片：获取尺寸并格式化
                  for (const url of imageUrls) {
                    if (!existingMdUrls.has(url)) {
                      // 这个 URL 不在文本的 markdown 格式中，需要追加
                      // 尝试获取图片尺寸
                      try {
                        const size = await getImageSize(url);
                        const mdImage = formatQQBotMarkdownImage(url, size);
                        imagesToAppend.push(mdImage);
                        log?.info(`[qqbot:${account.accountId}] Formatted image: ${size ? `${size.width}x${size.height}` : 'default size'} - ${url.slice(0, 60)}...`);
                      } catch (err) {
                        // 获取尺寸失败，使用默认尺寸
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size, using default: ${err}`);
                        const mdImage = formatQQBotMarkdownImage(url, null);
                        imagesToAppend.push(mdImage);
                      }
                    }
                  }
                  
                  // 处理文本中已有的 markdown 图片：检查是否需要补充尺寸信息
                  for (const match of mdMatches) {
                    const fullMatch = match[0];  // ![alt](url)
                    const altText = match[1];     // alt 部分
                    const imgUrl = match[2];      // url 部分
                    
                    // 检查是否已经有 QQBot 格式的尺寸 ![#宽px #高px](url)
                    if (!hasQQBotImageSize(fullMatch)) {
                      // 没有尺寸信息，需要补充
                      try {
                        const size = await getImageSize(imgUrl);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, size);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                        log?.info(`[qqbot:${account.accountId}] Updated image with size: ${size ? `${size.width}x${size.height}` : 'default'} - ${imgUrl.slice(0, 60)}...`);
                      } catch (err) {
                        // 获取尺寸失败，使用默认尺寸
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size for existing md, using default: ${err}`);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, null);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                      }
                    }
                    // 如果已经有尺寸信息，保留原格式
                  }
                  
                  // 从文本中移除裸 URL 图片（已转换为 markdown 格式）
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 追加需要添加的图片到文本末尾
                  if (imagesToAppend.length > 0) {
                    textWithoutImages = textWithoutImages.trim();
                    if (textWithoutImages) {
                      textWithoutImages += "\n\n" + imagesToAppend.join("\n");
                    } else {
                      textWithoutImages = imagesToAppend.join("\n");
                    }
                  }
                  
                  // 发送带图片的 markdown 消息（文本+图片一起发送）
                  if (textWithoutImages.trim()) {
                    try {
                      await sendWithTokenRetry(async (token) => {
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId);
                        }
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent markdown message with ${imageUrls.length} images (${event.type})`);
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to send markdown message: ${err}`);
                    }
                  }
                } else {
                  // ============ 普通文本模式：使用富媒体 API 发送图片 ============
                  // 从文本中移除所有图片相关内容
                  for (const match of mdMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 处理文本中的 URL 点号（防止被 QQ 解析为链接）
                  if (textWithoutImages) {
                    const originalText = textWithoutImages;
                    textWithoutImages = textWithoutImages.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
                    if (textWithoutImages !== originalText && textWithoutImages.trim()) {
                      textWithoutImages += "\n\n（由于平台限制，回复中的部分符号已被替换）";
                    }
                  }
                  
                  try {
                    // 发送图片（通过富媒体 API）
                    for (const imageUrl of imageUrls) {
                      try {
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                          } else if (event.channelId) {
                            // 频道暂不支持富媒体，发送文本 URL
                            await sendChannelMessage(token, event.channelId, imageUrl, event.messageId);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent image via media API: ${imageUrl.slice(0, 80)}...`);
                      } catch (imgErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
                      }
                    }

                    // 发送文本消息
                    if (textWithoutImages.trim()) {
                      await sendWithTokenRetry(async (token) => {
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId);
                        }
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent text reply (${event.type})`);
                    }
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
                  }
                }

                pluginRuntime.channel.activity.record({
                  channel: "qqbot",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                
                // 发送错误提示给用户，显示完整错误信息
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("[ClawdBot] 大模型 API Key 可能无效，请检查配置");
                } else {
                  // 显示完整错误信息，截取前 500 字符
                  await sendErrorMessage(`[ClawdBot] 出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {},
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
              await sendErrorMessage("[ClawdBot] QQ响应正常，但未收到clawdbot响应，请检查大模型是否正确配置");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`[ClawdBot] 处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        startMessageProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify
                // 如果有上次成功的级别，直接使用；否则从当前级别开始尝试
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: intentLevel.intents,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                // 记录成功的权限级别
                lastSuccessfulIntentLevel = intentLevelIndex;
                const successLevel = INTENT_LEVELS[intentLevelIndex];
                log?.info(`[qqbot:${account.accountId}] Ready with ${successLevel.description}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c", // 频道用户按 c2c 类型存储
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "guild",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道私信用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c",
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                // P1-3: 记录已知用户（群组用户）
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              const currentLevel = INTENT_LEVELS[intentLevelIndex];
              log?.error(`[qqbot:${account.accountId}] Invalid session (${currentLevel.description}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                
                // 尝试降级到下一个权限级别
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  const nextLevel = INTENT_LEVELS[intentLevelIndex];
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${nextLevel.description}`);
                } else {
                  // 已经是最低权限级别了
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed. Please check AppID/Secret.`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理
        // 4009: 可以重新发起 resume
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        if (code === 4009) {
          // 4009 可以尝试 resume，保留 session
          log?.info(`[qqbot:${account.accountId}] Error 4009, will try resume`);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}

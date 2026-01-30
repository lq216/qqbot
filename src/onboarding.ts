/**
 * QQBot CLI Onboarding Adapter
 * 
 * 提供 moltbot onboard 命令的交互式配置支持
 */
import type { 
  ChannelOnboardingAdapter,
  ChannelOnboardingStatus,
  ChannelOnboardingStatusContext,
  ChannelOnboardingConfigureContext,
  ChannelOnboardingResult,
} from "clawdbot/plugin-sdk";
import { listQQBotAccountIds, resolveQQBotAccount } from "./config.js";

const DEFAULT_ACCOUNT_ID = "default";

// 内部类型（避免循环依赖）
interface MoltbotConfig {
  channels?: {
    qqbot?: QQBotChannelConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QQBotChannelConfig {
  enabled?: boolean;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  name?: string;
  imageServerBaseUrl?: string;
  accounts?: Record<string, {
    enabled?: boolean;
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
    imageServerBaseUrl?: string;
  }>;
}

/**
 * 解析默认账户 ID
 */
function resolveDefaultQQBotAccountId(cfg: MoltbotConfig): string {
  const ids = listQQBotAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * QQBot Onboarding Adapter
 */
export const qqbotOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "qqbot" as any,

  getStatus: async (ctx: ChannelOnboardingStatusContext): Promise<ChannelOnboardingStatus> => {
    const { cfg } = ctx;
    const configured = listQQBotAccountIds(cfg as MoltbotConfig).some((accountId) => {
      const account = resolveQQBotAccount(cfg as MoltbotConfig, accountId);
      return Boolean(account.appId && account.clientSecret);
    });

    return {
      channel: "qqbot" as any,
      configured,
      statusLines: [`QQ Bot: ${configured ? "已配置" : "需要 AppID 和 ClientSecret"}`],
      selectionHint: configured ? "已配置" : "支持 QQ 群聊和私聊",
      quickstartScore: configured ? 1 : 20,
    };
  },

  configure: async (ctx: ChannelOnboardingConfigureContext): Promise<ChannelOnboardingResult> => {
    const { cfg, prompter, accountOverrides, shouldPromptAccountIds } = ctx;
    const moltbotCfg = cfg as MoltbotConfig;
    
    const qqbotOverride = (accountOverrides as Record<string, string>).qqbot?.trim();
    const defaultAccountId = resolveDefaultQQBotAccountId(moltbotCfg);
    let accountId = qqbotOverride ?? defaultAccountId;

    // 是否需要提示选择账户
    if (shouldPromptAccountIds && !qqbotOverride) {
      const existingIds = listQQBotAccountIds(moltbotCfg);
      if (existingIds.length > 1) {
        accountId = await prompter.select({
          message: "选择 QQBot 账户",
          options: existingIds.map((id) => ({
            value: id,
            label: id === DEFAULT_ACCOUNT_ID ? "默认账户" : id,
          })),
          initialValue: accountId,
        });
      }
    }

    let next = moltbotCfg;
    const resolvedAccount = resolveQQBotAccount(next, accountId);
    const accountConfigured = Boolean(resolvedAccount.appId && resolvedAccount.clientSecret);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const envAppId = typeof process !== "undefined" ? process.env?.QQBOT_APP_ID?.trim() : undefined;
    const envSecret = typeof process !== "undefined" ? process.env?.QQBOT_CLIENT_SECRET?.trim() : undefined;
    const canUseEnv = allowEnv && Boolean(envAppId && envSecret);
    const hasConfigCredentials = Boolean(resolvedAccount.config.appId && resolvedAccount.config.clientSecret);

    let appId: string | null = null;
    let clientSecret: string | null = null;

    // 显示帮助
    if (!accountConfigured) {
      await prompter.note(
        [
          "1) 打开 QQ 开放平台: https://q.qq.com/",
          "2) 创建机器人应用，获取 AppID 和 ClientSecret",
          "3) 在「开发设置」中添加沙箱成员（测试阶段）",
          "4) 你也可以设置环境变量 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET",
          "",
          "文档: https://bot.q.qq.com/wiki/",
        ].join("\n"),
        "QQ Bot 配置",
      );
    }

    // 检测环境变量
    if (canUseEnv && !hasConfigCredentials) {
      const keepEnv = await prompter.confirm({
        message: "检测到环境变量 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET，是否使用？",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...next.channels?.qqbot,
              enabled: true,
            },
          },
        };
      } else {
        // 手动输入
        appId = String(
          await prompter.text({
            message: "请输入 QQ Bot AppID",
            placeholder: "例如: 102146862",
            initialValue: resolvedAccount.appId || undefined,
            validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "请输入 QQ Bot ClientSecret",
            placeholder: "你的 ClientSecret",
            validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
          }),
        ).trim();
      }
    } else if (hasConfigCredentials) {
      // 已有配置
      const keep = await prompter.confirm({
        message: "QQ Bot 已配置，是否保留当前配置？",
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "请输入 QQ Bot AppID",
            placeholder: "例如: 102146862",
            initialValue: resolvedAccount.appId || undefined,
            validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "请输入 QQ Bot ClientSecret",
            placeholder: "你的 ClientSecret",
            validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
          }),
        ).trim();
      }
    } else {
      // 没有配置，需要输入
      appId = String(
        await prompter.text({
          message: "请输入 QQ Bot AppID",
          placeholder: "例如: 102146862",
          initialValue: resolvedAccount.appId || undefined,
          validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
        }),
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "请输入 QQ Bot ClientSecret",
          placeholder: "你的 ClientSecret",
          validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
        }),
      ).trim();
    }

    // 询问是否配置图片发送功能
    let imageServerBaseUrl: string | null = null;
    const existingImageUrl = (next.channels?.qqbot as QQBotChannelConfig)?.imageServerBaseUrl 
      || process.env.QQBOT_IMAGE_SERVER_BASE_URL;
    
    const wantImageSupport = await prompter.confirm({
      message: "是否启用图片发送功能？（需要服务器有公网 IP）",
      initialValue: Boolean(existingImageUrl),
    });
    
    if (wantImageSupport) {
      imageServerBaseUrl = String(
        await prompter.text({
          message: "请输入服务器公网地址（格式: http://公网IP:18765）",
          placeholder: "例如: http://123.45.67.89:18765",
          initialValue: existingImageUrl || undefined,
          validate: (value) => {
            if (!value?.trim()) return "公网地址不能为空";
            if (!value.startsWith("http://") && !value.startsWith("https://")) {
              return "地址必须以 http:// 或 https:// 开头";
            }
            return undefined;
          },
        }),
      ).trim();
      
      await prompter.note(
        [
          "图片发送功能已启用。请确保：",
          "1. 服务器防火墙已开放 18765 端口",
          "2. 云服务器安全组已放行 18765 端口（入站）",
          "",
          "如果图片发送失败，请检查端口是否可从公网访问。",
        ].join("\n"),
        "图片功能配置",
      );
    }

    // 应用配置
    if (appId && clientSecret) {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...next.channels?.qqbot,
              enabled: true,
              appId,
              clientSecret,
              ...(imageServerBaseUrl ? { imageServerBaseUrl } : {}),
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...next.channels?.qqbot,
              enabled: true,
              accounts: {
                ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts,
                [accountId]: {
                  ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId],
                  enabled: true,
                  appId,
                  clientSecret,
                  ...(imageServerBaseUrl ? { imageServerBaseUrl } : {}),
                },
              },
            },
          },
        };
      }
    } else if (imageServerBaseUrl) {
      // 只更新 imageServerBaseUrl
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...next.channels?.qqbot,
              imageServerBaseUrl,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...next.channels?.qqbot,
              accounts: {
                ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts,
                [accountId]: {
                  ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId],
                  imageServerBaseUrl,
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next as any, accountId };
  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...(cfg as MoltbotConfig).channels,
      qqbot: { ...(cfg as MoltbotConfig).channels?.qqbot, enabled: false },
    },
  }) as any,
};

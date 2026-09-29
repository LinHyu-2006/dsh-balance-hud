window.__ModuleLoader__.load({
	id: "dsh-balance-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/**
		 * 版本标记：显示在 tooltip 里，用来一眼确认浏览器加载的是哪一版 bundle。
		 * 客户端 bundle 的更新依赖页面重新拉取，遇到「改了没反应」时先看这个。
		 */


		//#region 价格表（元 / 百万 tokens，官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
		/**
		 * 每个模型两档价：峰时价与闲时价。官方规则是「闲时 = 峰时的一半」，
		 * 峰时 = 北京时间周一至周五 9:00–12:00、14:00–18:00，其余时段（含周末
		 * 与法定节假日）全部按闲时计。
		 */
		const PRICES = {
			"deepseek-flash": {
				label: "DeepSeek-V4.1-Flash",
				cacheHit: { peak: 0.04, off: 0.02 },
				cacheMiss: { peak: 2, off: 1 },
				output: { peak: 8, off: 4 }
			},
			"deepseek-v4-pro": {
				label: "DeepSeek-V4-Pro",
				cacheHit: { peak: 0.3, off: 0.15 },
				cacheMiss: { peak: 9, off: 4.5 },
				output: { peak: 27, off: 13.5 }
			}
		};

		/** 兜底：未知模型按 flash 价算，避免显示成 0 让人以为免费。 */
		const FALLBACK_MODEL = "deepseek-flash";

		/**
		 * 当前是否处于官方高峰时段。用本地时间换算出北京时间，只取「星期 + 小时」，
		 * 不引入任何时区库。
		 * @param now - 本地当前时间。
		 * @returns 是否按峰时价计费。
		 */
		function isPeakHour(now) {
			const beijing = new Date(now.getTime() + (480 + now.getTimezoneOffset()) * 60000);
			if (beijing.getDay() === 0 || beijing.getDay() === 6) return false;
			const minutes = beijing.getHours() * 60 + beijing.getMinutes();
			return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
		}

		/**
		 * 把一份用量折算成金额。
		 * @param usage - tokenUsage 投影（未缓存输入 / 缓存读 / 缓存写 / 输出）。
		 * @param model - 模型 id，未知时回落 flash。
		 * @param peak - 是否峰时价。
		 * @returns 明细与合计（元）。
		 */
		function costOf(usage, model, peak) {
			if (usage === undefined || usage === null) return null;
			const price = PRICES[model] ?? PRICES[FALLBACK_MODEL];
			const tier = peak ? "peak" : "off";
			// 缓存写按未命中输入计；数量级与官方扣费口径一致。
			const missTokens =
				(Number(usage.uncachedInputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
			const hitTokens = Number(usage.cacheReadTokens) || 0;
			const outputTokens = Number(usage.outputTokens) || 0;
			const parts = {
				model: PRICES[model] === undefined ? FALLBACK_MODEL : model,
				unknownModel: PRICES[model] === undefined,
				usingPriceOf: PRICES[model] === undefined ? FALLBACK_MODEL : model,
				tier,
				missTokens,
				hitTokens,
				outputTokens,
				miss: (missTokens / 1e6) * price.cacheMiss[tier],
				hit: (hitTokens / 1e6) * price.cacheHit[tier],
				output: (outputTokens / 1e6) * price.output[tier]
			};
			parts.total = parts.miss + parts.hit + parts.output;
			parts.price = price;
			return parts;
		}
		//#endregion

		//#region 数字格式化
		function currencySymbol(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		/**
		 * 余额：与官方设置页同口径（不足 0.01 显示 `<¥0.01`，四位小数）。
		 * @param value - 十进制字符串或数字。
		 * @param symbol - 币种符号。
		 * @returns 展示文本。
		 */
		function formatMoney(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount <= 0) return `${symbol}0.00`;
			if (amount < 0.01) return `<${symbol}0.01`;
			return `${symbol}${amount.toLocaleString("zh-CN", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2
			})}`;
		}

		/**
		 * 小卡片用的花费文本：**精确到分（2 位小数）**。
		 * 日常一眼看清够用，字数也短。
		 *
		 * @param value - 金额（元）。
		 * @param symbol - 币种符号。
		 * @returns 展示文本，例如 `¥0.59`。
		 */
		function formatCostShort(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount === 0) return `${symbol}0.00`;
			if (Math.abs(amount) < 0.005) return `${amount > 0 ? "<" : ">"}${symbol}0.01`;
			return `${amount < 0 ? "-" : ""}${symbol}${Math.abs(amount).toFixed(2)}`;
		}

		/**
		 * 明细面板用的花费文本：**4 位小数**。
		 *
		 * 为什么面板要多两位：token 量级的花费常常不足 1 分，2 位小数会全是 `0.00`，
		 * 看不出差别。仍然保留 `0.0001` 这颗"最小单位"的哨兵 —— 花了钱就绝不显示成 0。
		 *
		 * @param value - 金额（元）。
		 * @param symbol - 币种符号。
		 * @returns 展示文本，例如 `¥0.5900`。
		 */
		function formatCost(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount === 0) return `${symbol}0.0000`;
			if (Math.abs(amount) < 0.0001) return `${amount > 0 ? "<" : ">"}${symbol}0.0001`;
			return `${amount < 0 ? "-" : ""}${symbol}${Math.abs(amount).toFixed(4)}`;
		}

		function formatTokens(count) {
			const value = Number(count) || 0;
			if (value < 1000) return String(value);
			if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
			return `${(value / 1e6).toFixed(2)}M`;
		}

		/**
		 * 把时间戳格式化成 HH:MM:SS，用于面板里的"更新于 …"。
		 * @param timestamp - 毫秒时间戳。
		 * @returns 本地时间文本。
		 */
		function formatClock(timestamp) {
			try {
				const date = new Date(timestamp);
				const pad = (value) => String(value).padStart(2, "0");
				return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
			} catch {
				return "--:--:--";
			}
		}
		//#endregion

		//#region 余额读取
		/**
		 * 前台刷新间隔。开销参考：一次本地回环 GET（约 200 字节）+ Host 一次平台查询。
		 * 60 秒足够"看着不滞后"，同时把后台唤醒压到每分钟一次。
		 * 想更实时就调小；想更省电就调大。
		 */
		const BALANCE_POLL_MS = 60000;
		/** 页面不可见（切标签 / 最小化）时的间隔：挂机场景下把唤醒频率降到 12 次/小时。 */
		const BALANCE_POLL_HIDDEN_MS = 300000;
		/** 读取失败后的快速重试节奏（毫秒）；用完即回到 BALANCE_POLL_MS。 */
		const BALANCE_RETRY_MS = [1000, 2000, 5000, 10000, 20000];
		/** Host 半边注册的只读余额路由。 */
		const BALANCE_ROUTE = "/api/balance-hud/balance";
		/** 赠金信号路由（Host 半边只读、不回执）。用于印证"余额跳高"是不是官方赠金。 */
		const BONUS_ROUTE = "/api/balance-hud/bonuses";

		/**
		 * 当前该用的刷新间隔：页面可见性与轮询频率挂钩。
		 * @returns 毫秒间隔。
		 */
		function pollInterval() {
			try {
				return globalThis.document?.hidden === true ? BALANCE_POLL_HIDDEN_MS : BALANCE_POLL_MS;
			} catch {
				return BALANCE_POLL_MS;
			}
		}

		/**
		 * 读一次账户余额。
		 *
		 * **为什么走 HTTP 而不是 `ctx.remote.account`**：客户端插件的 `ctx.remote`
		 * 受 Cordis 依赖守卫保护，未声明就访问会抛
		 * `cannot get property "remote.account" without inject`；而客户端侧声明
		 * `inject = ["remote"]` 又无法满足（fiber 一直挂起）。所以余额由 **Host 半边**
		 * 通过 `ctx.deepseekAccount` 读取，经只读回环路由交给这里。协议不变，仍是三态：
		 * - `{ kind: "ready", currency, rechargeTotal, bonusTotal, total }` 已登录且拿到钱包；
		 * - `{ kind: "unavailable", reason }` 未登录 / 凭据变更；
		 * - `{ kind: "error", reason }` 查询失败、路由不可达、响应不合法。
		 *
		 * @returns 上述三态之一。
		 */
		async function readBalance() {
			let response;
			try {
				response = await fetch(BALANCE_ROUTE, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
			} catch (error) {
				return {
					kind: "error",
					reason: `余额路由不可达：${error && error.message ? error.message : String(error)}`
				};
			}
			if (!response.ok) {
				return { kind: "error", reason: `余额路由返回 HTTP ${response.status}` };
			}
			let payload;
			try {
				payload = await response.json();
			} catch {
				return { kind: "error", reason: "余额路由返回了非 JSON 内容" };
			}
			if (payload?.kind !== "ready" && payload?.kind !== "unavailable" && payload?.kind !== "error") {
				return { kind: "error", reason: `余额路由返回了未知形状：${JSON.stringify(payload)?.slice(0, 120)}` };
			}
			return payload;
		}

		/**
		 * 读官方「未回执的赠金」列表（只读、不回执）。
		 *
		 * **仅作充值的印证信号**：余额跳高时拿它判断是不是官方发的赠金。
		 * 因为**不回执**（Host 不调 `ackBonusNotified`），所以不会影响 DSH 自己的赠金通知，
		 * 这份数据会一直可读；本地用 orderId 去重即可。
		 *
		 * 失败一律降级为空列表：印证只是加分项，判据主体仍是 token 估算上界。
		 *
		 * @returns 赠金条目数组（含 orderId / amount / grantedAt）。
		 */
		async function readBonuses() {
			try {
				const response = await fetch(BONUS_ROUTE, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
				if (!response.ok) return [];
				const payload = await response.json();
				if (payload?.kind !== "ready" || !Array.isArray(payload.bonuses)) return [];
				return payload.bonuses;
			} catch {
				return [];
			}
		}
		//#endregion

		//#region HUD 组件
		const SANS =
			'var(--dsh-font-family-sans, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif)';

		const rootStyle = {
			// 钉在右下角；宽度由内容决定，折叠时自动收紧。
			position: "fixed",
			right: "14px",
			bottom: "12px",
			zIndex: 60,
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			// 玻璃层负责把鼠标事件交给子元素；卡片与面板各自 auto。
			pointerEvents: "none",
			fontFamily: SANS
		};

		/**
		 * 卡片与面板共用的外层容器。
		 *
		 * **刻意不把悬停判定挂在它身上**：面板宽 286px、卡片窄（约 96px）且靠右，
		 * 两者错开形成的区域**不是矩形** —— 任何单一容器的盒子都会多出"左边有、下面没有"
		 * 的一块空白。用容器盒判断，指针往左滑进那块空白时不会收起，也就是
		 * 「左侧感觉是详情页的左侧，而我要的是小卡片的左侧」。
		 *
		 * 所以悬停改由**两个元素各自**的 mouseenter / mouseleave 承担（见 hoverOn / hoverOff），
		 * "面板的左边"与"卡片的左边"成为两件独立的事。容器只负责右对齐与 8px 视觉留白。
		 */
		const hoverSurfaceStyle = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			gap: "8px"
		};

		/**
		 * 卡片用**两列网格**：标签列与数值列各自对齐。
		 * 三行的标签左对齐、金额右对齐，数字位数变化时列宽也不再跳动。
		 */
		const cardStyle = {
			pointerEvents: "auto",
			display: "inline-grid",
			gridTemplateColumns: "auto auto",
			columnGap: "10px",
			rowGap: "1px",
			padding: "6px 10px",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
			background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))",
			boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.16))",
			color: "var(--dsw-alias-label-primary, #1b1b1f)",
			fontSize: "12px",
			lineHeight: "16px",
			cursor: "pointer",
			userSelect: "none",
			whiteSpace: "nowrap",
			maxWidth: "200px"
		};

		/** 网格里标签 / 数值的对齐方式。 */
		const gridLabelStyle = {
			color: "var(--dsw-alias-label-tertiary, #8a8a8f)",
			fontSize: "11px",
			textAlign: "left"
		};
		const gridValueStyle = {
			fontVariantNumeric: "tabular-nums",
			fontWeight: 500,
			textAlign: "right"
		};

		/** 折叠态：只留一个角标。 */
		const collapsedCardStyle = {
			...cardStyle,
			gridTemplateColumns: "auto",
			columnGap: 0,
			padding: "4px 8px",
			fontSize: "11px",
			lineHeight: "14px"
		};

		const labelStyle = { color: "var(--dsw-alias-label-tertiary, #8a8a8f)", fontSize: "11px" };
		const valueStyle = { fontVariantNumeric: "tabular-nums", fontWeight: 500 };
		/**
		 * 明细面板。
		 *
		 * **不再是 `position: fixed` + 硬编码 `bottom`**，而是「卡片外层」里的一个
		 * 普通流内子元素，两者之间用外层容器的 `gap: 8px` 留白。
		 *
		 * 关键差别：流内布局下，那段 8px 空白**属于外层容器自己的盒子**，指针经过它时
		 * 依然在外层容器内 —— 不会出现"指针跑到两个元素之间的空隙里、判定为移出"的漏判。
		 * 之前的 fixed + 硬编码偏移方案里，空白是真正的空档，才需要靠坐标计算去补。
		 */
		const panelStyle = {
			pointerEvents: "auto",
			width: "286px",
			boxSizing: "border-box",
			padding: "10px 12px",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
			background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))",
			boxShadow: "var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.24))",
			color: "var(--dsw-alias-label-primary, #1b1b1f)",
			fontSize: "12px",
			lineHeight: "18px",
			fontFamily: SANS
		};

		const rowStyle = { display: "flex", justifyContent: "space-between", gap: "12px" };
		const hintStyle = {
			marginTop: "8px",
			paddingTop: "8px",
			borderTop: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))",
			color: "var(--dsw-alias-label-tertiary, #8a8a8f)",
			fontSize: "11px",
			lineHeight: "16px"
		};

		function Row(props) {
			return h(
				"div",
				{ style: rowStyle },
				h("span", { style: labelStyle }, props.label),
				h("span", { style: valueStyle }, props.value)
			);
		}

		/**
		 * 一行纯文本摘要，只喂给 `aria-label`（屏幕阅读器）。
		 *
		 * **不用于 `title`**：宿主此前把这份明细挂在 `title` 上，悬停约 1 秒后浏览器
		 * 会弹一个原生黑框 tooltip，与自绘的悬停面板重复且互相打架，已移除。
		 *
		 * @param balance - 余额三态。
		 * @param cost - 估价明细或 null。
		 * @param estimate - 本会话预估（递推值）；null 表示还没算出来。
		 * @param sessionId - 活动会话 id。
		 * @returns 单行摘要。
		 */
		function buildSummary(balance, cost, estimate, sessionId) {
			const parts = [];
			if (balance?.kind === "ready") {
				const symbol = currencySymbol(balance.currency);
				parts.push(`余额 ${formatMoney(balance.total, symbol)}`);
			} else if (balance === undefined) {
				parts.push("余额 读取中");
			} else if (balance.kind === "unavailable") {
				parts.push("余额 未登录");
			} else {
				parts.push("余额 读取失败");
			}
			if (estimate === null) {
				parts.push(cost === null ? "本会话预估 无用量" : `本会话预估 ${formatCostShort(cost.total, "¥")}`);
			} else {
				parts.push(`本会话预估 ${formatCostShort(estimate, "¥")}`);
			}
			if (sessionId !== undefined) parts.push(`会话 ${sessionId.slice(0, 8)}`);
			return parts.join("，");
		}

		/**
		 * 右下角 HUD：余额 + 本会话花费。
		 *
		 * 数据来源两条：
		 * - 余额走 Host 只读路由 `/api/balance-hud/balance`（30 秒轮询 + 失败退避重试）；
		 * - 花费走会话 `tokenUsage` 投影，乘官方价格表得预估金额；同时用**持久化**
		 *   的余额基线给出「实际」口径。
		 *
		 * @param props - 注入的 ctx、活动会话 id、用量与余额读取器。
		 * @returns 常驻右下角的浮层。
		 */
		function BalanceHud(props) {
			const ctx = props.ctx;
			// 会话 id 双通道：框架标准 share `useSessions`（若宿主在根作用域提供了它）
			// 优先，取不到就回落到注册时 inject() 采到的快照。两条都不通时依然渲染
			// 余额，只是「本会话」显示为待命状态。
			const hookedSessionId = typeof props.useSessions === "function"
				? props.useSessions((state) => {
						const rows = Object.values(state?.byId ?? {});
						return rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
					})
				: undefined;
			const sessionId = hookedSessionId ?? props.sessionId;
			const [usage, setUsage] = React.useState(undefined);
			const [usageError, setUsageError] = React.useState(undefined);
			const [balance, setBalance] = React.useState(undefined);
			// 交互状态合成一个 state（一次只改一处，hook 时序更稳）：
			// `hover` = 鼠标悬停展开明细，`collapsed` = 点击折叠成角标，`rev` = 手动刷新计数。
			const [ui, setUi] = React.useState({ hover: false, collapsed: false, rev: 0, refreshing: false });
			const { hover, collapsed, rev, refreshing } = ui;
			/**
			 * 「本会话预估」的递推基准：上一次拿到分摊值时的 (token 成本, 分摊值) 配对。
			 * 两次余额刷新之间用"新增 token 的预估花费"往前推，让数字平滑增长。
			 */
			const confirmedRef = React.useRef({ sessionId: undefined, ownTokens: undefined, apportioned: undefined });
			/** 已经见过的赠金 orderId：赠金接口不回执，靠它去重，避免反复提示。 */
			const seenBonuses = React.useRef(new Set());
			/**
			 * 「我刚充值了」的处理中状态：点下去先重锚（本地、瞬时），
			 * 再查一次官方赠金做印证；查询期间显示「查询中…」。
			 * 这样这个按钮的反馈是有实际工作支撑的，不是纯装饰。
			 */
			const [markingTopUp, setMarkingTopUp] = React.useState(false);
			/**
			 * 最近一次渲染时算出的分摊快照 (own=本会话 token 成本, all=全部会话 token 成本之和)。
			 * 余额刷新完成时用它落定递推基准，避免在 effect 里重算一遍导致口径不一致。
			 */
			const apportionedRef = React.useRef({ sessionId: undefined, own: undefined, model: undefined, peak: undefined });
			/** 识别到充值后的短暂提示（面板里显示一行，约 12 秒后自己消失）。 */
			const [topupNotice, setTopupNotice] = React.useState(null);
			/** 手动刷新计数：用于区分"用户点的刷新"与"自动轮询"。 */
			const refreshRequested = React.useRef(false);
			/** 最近一次成功读到余额的时间（用于显示"刚刚更新"）。 */
			const [lastSuccessAt, setLastSuccessAt] = React.useState(undefined);
			/**
			 * 收起延时（ms）。卡片与面板是两个独立元素，指针从卡片移到面板时
			 * 会先触发卡片的 mouseleave；给它一点时间，让面板的 mouseenter
			 * 有机会取消这次收起，避免"往面板上移就消失"。
			 * 指针往上/往左离开任何一个元素时，没有后续 enter 来取消，延时到点即收起。
			 */
			const HOVER_CLOSE_MS = 140;
			const hoverCloseTimer = React.useRef(undefined);

			/** 指针进入卡片或面板：取消待收起，并确保展开。 */
			const hoverOn = () => {
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = undefined;
				setUi((state) => (state.hover ? state : { ...state, hover: true }));
			};
			/** 指针离开卡片或面板：延时收起（另一个元素的 enter 会取消它）。 */
			const hoverOff = () => {
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = setTimeout(() => {
					hoverCloseTimer.current = undefined;
					setUi((state) => (state.hover ? { ...state, hover: false } : state));
				}, HOVER_CLOSE_MS);
			};

			// 活动会话的 tokenUsage 投影：订阅式读取 + 兜底轮询，会话切换自动重挂。
			React.useEffect(() => {
				setUsage(undefined);
				setUsageError(undefined);
				if (sessionId === undefined) return undefined;
				const read = () => {
					try {
						const face = ctx.sessions?.binding?.(sessionId)?.session?.projections?.faceOf("tokenUsage");
						if (face === undefined) return undefined;
						setUsage(face.getSnapshot());
						setUsageError(undefined);
						return face;
					} catch (error) {
						setUsageError(String(error && error.message ? error.message : error));
						return undefined;
					}
				};
				const face = read();
				const unsubscribe = face?.subscribe?.(read);
				const timer = setInterval(read, 5000);
				return () => {
					clearInterval(timer);
					unsubscribe?.();
				};
			}, [ctx, sessionId, rev]);

			// 基线现在挂在**账户级**：锚点表由 apply 创建、通过 inject 以 props.baselineStage 传入，
			// 因为账户级计算发生在 inject 的闭包里（那里才拿得到 store）。
			const { baselineStage } = props;
			/**
			 * 锚点表的版本号。**store 是普通对象，改它不会触发重渲染** ——
			 * 而"哪些会话在分摊"正是渲染时读 store 得到的。少了这个版本号会出现：
			 * 分母只算到本会话 → 占比恒为 100% → 每个会话的预估值都等于账户级（看起来"都一样"）。
			 */
			const [epoch, setEpoch] = React.useState(0);
			// epoch 本身不参与计算，它的作用就是"强制再渲染一次"；此处读取以满足 lint
			void epoch;
			const bumpEpoch = () => setEpoch((value) => value + 1);
			// 充值提示自动消失（可观测性，但不占地方）
			React.useEffect(() => {
				if (topupNotice === null) return undefined;
				const timer = setTimeout(() => setTopupNotice(null), TOPUP_NOTICE_MS);
				return () => clearTimeout(timer);
			}, [topupNotice]);
			/** 把当前会话登记进锚点表（已存在则只更新"最近访问"时间）。 */
			const registerActiveSession = (total) => {
				checkoutSession(sessionId, typeof total === "number" ? total : null);
			};
			React.useEffect(() => {
				baselineStage.store = readStore();
				registerActiveSession(baselineStage.runningBalance);
				baselineStage.activeSession = sessionId;
				// 登记完立刻让渲染重来一次，让 denominator（全会话 token）重新取数
				bumpEpoch();
				// sessionId / rev 变化时重新登记（rev 是手动刷新）
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [sessionId, rev]);

			// 余额：**订阅官方 account/watch 推送流**（设置 → 账号与余额 用的同一条通道），
			// 推送一到就重读余额。这样只有一个数据源：Host 查一次，设置页和 HUD 同时更新，
			// 余额：轮询 Host 只读路由。前台 60 秒一次，页面隐藏时降到 5 分钟一次，
			// 页面回到前台立刻补一次。失败按 1s→2s→5s→10s→20s 退避重试（仅在出错时）。
			React.useEffect(() => {
				let disposed = false;
				let timer;
				let attempt = 0;
				const schedule = (delay) => {
					if (disposed) return;
					clearTimeout(timer);
					timer = setTimeout(load, delay);
				};

				async function load() {
					let next;
					try {
						next = await readBalance();
					} catch (error) {
						next = { kind: "error", reason: `余额读取意外失败：${error && error.message ? error.message : String(error)}` };
					}
					if (disposed) return;
					setBalance(next);
					// 基线记账：**唯一的入口** —— observeRead 会判定这次读数是消费还是充值。
					if (next.kind === "ready") {
						baselineStage.runningBalance = next.total;
						baselineStage.activeSession = sessionId;
						registerActiveSession(next.total);
						// token 估算上界：期间全部会话的 token 预估花费之和（充值判据）
						const snapshot = apportionedRef.current;
						const others = Object.keys(baselineStage.store?.sessions ?? {})
							.filter((id) => id !== sessionId)
							.reduce((sum, id) => sum + (props.tokensOf?.(id, snapshot.model, snapshot.peak) ?? 0), 0);
						const bound = (snapshot.own ?? 0) + others;
						const verdict = observeRead(sessionId, next.total, bound);
						baselineStage.store = verdict.store ?? readStore();
						// 识别到外部变动 → 给面板一条短暂提示（可观测性，否则完全是静默的）
						if (verdict.kind === "expire") {
							// 外部**减钱**：最典型的就是赠金到期被平台回收。
							// 只移动了锚点、没有加进花费，所以要明确告诉用户这块钱去哪了。
							setTopupNotice({ kind: "expire", amount: verdict.amount, at: Date.now() });
						} else if (verdict.kind === "topup") {
							setTopupNotice({ kind: "topup", amount: verdict.amount, at: Date.now() });
							// 印证（方案 B）：查官方未回执赠金，命中就记下 orderId 去重。
							// 这只是加分项 —— 判据主体是 token 估算上界，接口不通也照样识别。
							readBonuses()
								.then((bonuses) => {
									if (disposed || bonuses.length === 0) return;
									const fresh = bonuses.filter((item) => !seenBonuses.current.has(item.orderId));
									for (const item of fresh) seenBonuses.current.add(item.orderId);
									if (fresh.length > 0) {
										setTopupNotice({
											kind: "topup",
											amount: verdict.amount,
											at: Date.now(),
											bonus: fresh.reduce((sum, item) => sum + (item.amount || 0), 0),
											// 最早的到期时间：让用户提前知道哪笔赠金要用掉
											expiresAt: fresh
												.map((item) => item.expiresAt)
												.filter((value) => typeof value === "string" && value !== "")
												.sort()[0]
										});
									}
								})
								.catch(() => {});
						}
						// 落定递推基准：用**计数器的确认值** × token 占比
						if (snapshot.sessionId === sessionId && typeof snapshot.own === "number") {
							const accountNow = sessionSpentOf(baselineStage.store, sessionId);
							if (typeof accountNow === "number") {
								const allNow = snapshot.own + others;
								confirmedRef.current = {
									sessionId,
									ownTokens: snapshot.own,
									apportioned: allNow > 0 ? accountNow * (snapshot.own / allNow) : 0
								};
							}
						}
						// store 变了 → 触发重渲染，重新计算"全会话 token"这个分母
						bumpEpoch();
					}
					// 手动刷新的收尾：无论成功失败都要清掉"刷新中"，否则按钮会一直转。
					if (refreshRequested.current) {
						refreshRequested.current = false;
						if (next.kind === "ready") setLastSuccessAt(Date.now());
						setUi((state) => (state.refreshing ? { ...state, refreshing: false } : state));
					} else if (next.kind === "ready") {
						setLastSuccessAt(Date.now());
					}
					if (next.kind === "ready") {
						attempt = 0;
						schedule(pollInterval());
						return;
					}
					// 未登录不是错误、也不该快重试；查询失败才退避重试。
					if (next.kind === "unavailable") {
						schedule(pollInterval());
						return;
					}
					schedule(BALANCE_RETRY_MS[Math.min(attempt, BALANCE_RETRY_MS.length - 1)]);
					attempt += 1;
				}

				// 页面回到前台时立刻补一次，并把间隔从"后台档"切回"前台档"。
				const onVisibility = () => {
					if (globalThis.document?.hidden === false) {
						clearTimeout(timer);
						load();
					}
				};
				try {
					globalThis.document?.addEventListener?.("visibilitychange", onVisibility);
				} catch {
					// 没有 document（非浏览器环境）时忽略。
				}

				load();
				return () => {
					disposed = true;
					clearTimeout(timer);
					try {
						globalThis.document?.removeEventListener?.("visibilitychange", onVisibility);
					} catch {
						// 同上
					}
				};
			// 依赖里必须带 sessionId：切换会话要**立刻**按新会话重读余额，
			// 否则最长 60 秒内显示的还是上一个会话的「实际扣费」，看起来像"没变"。
			}, [ctx, rev, sessionId]);

			const peak = isPeakHour(new Date());
			const model = props.model ?? "deepseek-flash";
			const cost = costOf(usage, model, peak);
			// balance 的三态：undefined=尚未返回；kind=ready/unavailable/error。
			const ready = balance?.kind === "ready";
			const currency = ready ? balance.currency : "CNY";
			const symbol = currencySymbol(currency);

			// —— 三个口径 ——
			// sessionActual（=accountActual）：**本会话**锚点 − 当前余额。跟着会话走，单会话即真实扣费。
			// ownActual：并行时按 token 比例拆出本会话那一份；单会话时等于 sessionActual。
			// accountTotal：账户级合计（各会话累计计数之和），只作面板参照。
            //           余额不携带"谁花的"，所以单会话真实扣费在本进程内不可观测；用可精确计算的
            //           token 成本当权重（四类 token 分别计价 + 峰谷价，见 costOf）。
			// ownEstimate：卡片上展示的「本会话预估」—— 两次刷新之间按新增 token **递推**：
			//           上次刷新确认的分摊值 + 此后新增 token 的预估花费。
			//           刷新一到位就落定到新的分摊值，所以数字是小步增长而不是每 60 秒跳一次。
			// sessionSpent：**本会话累计花费**（计数器，充值不影响它）。
			// ownActual：并行时再按 token 成本占比拆出本会话那一份；单会话时占比恒为 1，等于全额。
			// accountTotal：账户级合计（各会话计数之和），只在并行时作面板参照。
			const accountActual = props.sessionSpent?.() ?? null;
			const accountTotal = props.accountTotal?.() ?? null;
			const trackedSessions = props.trackedSessions?.() ?? [];
			const ownTokens = cost?.total ?? 0;
			// 其它会话的成本必须用**同一套价格口径**（同模型、同峰谷）才算得出可比权重。
			// 成本本身仍按四类 token 分别计价：未命中输入 / 缓存命中 / 缓存写 / 输出（见 costOf）。
			const otherTokens = trackedSessions
				.filter((id) => id !== sessionId)
				.reduce((sum, id) => sum + (props.tokensOf?.(id, model, peak) ?? 0), 0);
			const allTokens = ownTokens + otherTokens;
			// 分母为 0（没有任何 token 成本）时分摊值是 0，而不是退回全额 ——
			// 那才是"没有可分摊的花费"的正确含义。
			const ownActual =
				typeof accountActual !== "number" ? accountActual : allTokens > 0 ? accountActual * (ownTokens / allTokens) : 0;
			// 并行标记：除了本会话还有别的会话在跟踪里 → 界面要说明这是分摊值
			const parallel = trackedSessions.filter((id) => id !== sessionId).length > 0;
			// 把本次渲染的分摊输入留给余额 effect：刷新完成时它要用**刚读到的 store**
			// 重算分母（那时渲染还没跑，拿不到新的 trackedSessions）。
			apportionedRef.current = { sessionId, own: ownTokens, model, peak };

			// 递推基准：**在余额刷新完成时**写入（不在渲染阶段改 ref，避免读到半新半旧的状态）。
			// 记录"那次刷新时的 (token 成本, 分摊值)"配对，两次刷新之间用它 + 新增 token 往前推。
			const confirmed = confirmedRef.current;
			const confirmedValid = confirmed.sessionId === sessionId && typeof confirmed.ownTokens === "number";
			const ownEstimate = confirmedValid
				? confirmed.apportioned + Math.max(0, ownTokens - confirmed.ownTokens)
				: typeof ownActual === "number"
					? ownActual
					: null;

			/**
			 * 手动兜底：用户点了「我刚充值了」。
			 *
			 * 两步：① 重锚到当前余额（本地、瞬时，只抬锚点不动计数）；
			 * ② 查一次官方赠金做印证（网络，可能慢）—— 这一步支撑「查询中…」的反馈。
			 * 无论查询成功、无赠金还是接口不通，都会收尾清掉「查询中…」。
			 */
			const onMarkTopUp = async () => {
				if (!ready || markingTopUp) return;
				setMarkingTopUp(true);
				const touched = props.markTopUp?.(balance.total);
				if (touched === false) {
					setMarkingTopUp(false);
					return;
				}
				bumpEpoch();
				// 印证：查官方未回执赠金。接口不通也不影响 —— 重锚已经生效。
				let bonus = 0;
				try {
					const bonuses = await readBonuses();
					const fresh = bonuses.filter((item) => !seenBonuses.current.has(item.orderId));
					for (const item of fresh) seenBonuses.current.add(item.orderId);
					bonus = fresh.reduce((sum, item) => sum + (item.amount || 0), 0);
				} catch {
					bonus = 0;
				}
				setTopupNotice({ kind: "topup", amount: null, at: Date.now(), bonus, manual: true });
				setMarkingTopUp(false);
			};

			const onRefresh = () => {
				// 立刻给出"正在刷新"的反馈，并在完成后显示"刚刚更新"。
				setUi((state) => (state.refreshing ? state : { ...state, refreshing: true }));
				refreshRequested.current = true;
				setUi((state) => ({ ...state, rev: state.rev + 1 }));
			};
			/** 悬停展开 / 移开收起。 */
			const setHover = (value) => setUi((state) => (state.hover === value ? state : { ...state, hover: value }));
			/** 点击切换折叠（折叠后只留一个角标，也不再悬停展开）。 */
			const toggleCollapsed = () => setUi((state) => ({ ...state, collapsed: !state.collapsed, hover: false }));

			/** 徽标上的余额文字：等待 / 未登录 / 失败 / 金额，绝不把失败显示成 0。 */
			const balanceText =
				balance === undefined
					? "读取中"
					: ready
						? formatMoney(balance.total, symbol)
						: balance.kind === "unavailable"
							? "未登录"
							: "读取失败";

			// 摘要文本只给无障碍用（aria-label），**不挂 `title`**：原生 tooltip 会在
			// 悬停约 1 秒后弹出一个黑框，和自绘的明细面板重复又打架。
			const summary = buildSummary(balance, cost, ownEstimate, sessionId);
			const detailOpen = hover;

			// 折叠态：只留一个角标，点击展开。
			if (collapsed) {
				return h(
					"div",
					{ style: rootStyle },
					h(
						"div",
						{
							style: collapsedCardStyle,
							role: "button",
							tabIndex: 0,
							"aria-expanded": false,
							"aria-label": `余额 ${balanceText}，已折叠，点击展开。${summary}`,
							onClick: toggleCollapsed,
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									toggleCollapsed();
								}
							}
						},
						// 折叠态也是网格的一行：标签 + 数值两格。
						h("span", { style: gridLabelStyle }, "余额"),
						h("span", { style: gridValueStyle }, balanceText)
					)
				);
			}

			const badge = h(
				"div",
				{
					style: cardStyle,
					// 卡片自身的进 / 出：进入即展开；离开则延时收起
					// （指针若正好移进面板，面板的 onMouseEnter 会取消这次收起）。
					onMouseEnter: hoverOn,
					onMouseLeave: hoverOff,
					role: "button",
					tabIndex: 0,
					"aria-expanded": detailOpen,
					"aria-label": `${summary}。悬停看明细，点击折叠`,
					onClick: toggleCollapsed,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							toggleCollapsed();
						}
					}
				},
				// 两列网格，逐格摆放：第 1 行标签 / 第 1 行数值 / 第 2 行标签 …
				// 第 1 行：账户余额
				h("span", { style: gridLabelStyle }, "账户余额"),
				h("span", { style: gridValueStyle }, balanceText),
				// 第 2 行：本会话预估花费（递推值：上次确认的分摊值 + 此后新增 token 的预估）
				// 没有用量时显示「—」，而不是 ¥0.00：没跑过就不该显示"花了 0 元"这种肯定陈述。
				h("span", { style: gridLabelStyle }, "本会话预估"),
				h(
					"span",
					{ style: gridValueStyle },
					cost === null ? "—" : formatCostShort(ownEstimate === null ? cost.total : ownEstimate, symbol)
				)
			);

			const panel = detailOpen
				? h(
						"div",
						{
							style: panelStyle,
							// 面板自身的进 / 出：进入即取消收起（从卡片移过来时保住面板）；
							// 离开面板即延时收起 —— 于是"往左滑出面板左边"会收起，
							// 而不是被外层容器多出来的空白区域吃掉。
							onMouseEnter: hoverOn,
							onMouseLeave: hoverOff,
							role: "dialog",
							"aria-label": "余额与本会话花费"
						},
						h(
							"div",
							{ style: { ...rowStyle, marginBottom: "6px" } },
							h(
								"span",
								{ style: { fontWeight: 600 } },
								"账户余额",
								// 最近一次成功读取的时间：给"刷新"一个可见的凭据，
								// 否则点了按钮没有任何变化，看起来像没反应。
								typeof lastSuccessAt === "number"
									? h(
											"span",
											{ style: { ...labelStyle, fontWeight: 400, marginLeft: "6px" } },
											`更新于 ${formatClock(lastSuccessAt)}`
										)
									: null
							),
							h(
								"button",
								{
									type: "button",
									onClick: onRefresh,
									disabled: refreshing,
									"aria-busy": refreshing,
									style: {
										border: 0,
										background: "transparent",
										color: refreshing
											? "var(--dsw-alias-label-tertiary, #8a8a8f)"
											: "var(--dsw-alias-label-secondary, #5b5b60)",
										cursor: refreshing ? "default" : "pointer",
										fontSize: "11px",
										padding: 0
									}
								},
								refreshing ? "刷新中…" : "刷新"
							),
							// 手动兜底（方案 C）：万一自动判错，点一下就纠正 —— 只抬锚点、不动计数。
							// 处理中的反馈和「刷新」同款：先重锚（瞬时），再查赠金印证（网络），
							// 查询期间显示「查询中…」。
							h(
								"button",
								{
									type: "button",
									onClick: onMarkTopUp,
									disabled: !ready || markingTopUp,
									"aria-busy": markingTopUp,
									style: {
										border: 0,
										background: "transparent",
										color:
											ready && !markingTopUp
												? "var(--dsw-alias-label-secondary, #5b5b60)"
												: "var(--dsw-alias-label-tertiary, #8a8a8f)",
										cursor: ready && !markingTopUp ? "pointer" : "default",
										fontSize: "11px",
										padding: 0,
										marginLeft: "8px"
									}
								},
								markingTopUp ? "查询中…" : "我刚充值了"
							)
						),
						// 外部变动的短暂提示：只给可观测性，不中断任何计数。
						// 充值（余额被外部抬高）与过期回收（余额被外部扣减）都会提示，
						// 因为两者都**不计入花费**，不说一声用户会以为数字出错了。
						topupNotice !== null
							? h(
									"div",
									{ style: { ...hintStyle, color: "var(--dsw-alias-label-secondary, #5b5b60)" } },
									topupNotice.kind === "expire"
										? `检测到 ${formatCostShort(topupNotice.amount, symbol)} 非消费性扣减（赠金过期回收等），未计入花费。`
										: `${topupNotice.manual
												? "已按你的标记重锚基线"
												: `已识别充值 ${formatCostShort(topupNotice.amount, symbol)}`}，花费继续累计${
												topupNotice.bonus ? `（官方赠金 ${formatCostShort(topupNotice.bonus, symbol)} 印证）` : ""
											}${topupNotice.expiresAt ? `，最早到期 ${topupNotice.expiresAt.slice(0, 10)}` : ""}。`
								)
							: null,
						!ready
							? h(React.Fragment, null,
									h(Row, {
										label: "状态",
										value:
											balance === undefined
												? "读取中…"
												: balance.kind === "unavailable"
													? "未登录"
													: "读取失败"
									}),
									balance?.reason ? h(Row, { label: "原因", value: balance.reason }) : null
								)
							: h(React.Fragment, null,
									// 标签统一四个字，数值列右对齐，整块看起来像一张对齐的小表格。
									h(Row, { label: "充值余额", value: formatMoney(balance.rechargeTotal, symbol) }),
									balance.bonusTotal > 0
										? h(Row, { label: "赠金余额", value: formatMoney(balance.bonusTotal, symbol) })
										: null,
									h(Row, { label: "合计余额", value: formatMoney(balance.total, symbol) })
								),
						h("div", { style: { height: "8px" } }),
						h(
							"div",
							{ style: { ...rowStyle, marginBottom: "6px" } },
							h("span", { style: { fontWeight: 600 } }, "本会话花费"),
							h("span", { style: labelStyle }, cost === null ? "" : `${cost.tier === "peak" ? "峰时" : "闲时"}价`)
						),						cost === null
							? h(Row, { label: "状态", value: usageError ?? "当前会话无用量数据" })
							: h(React.Fragment, null,
									// 面板里的花费一律 4 位小数：token 量级的花费常不足 1 分，
									// 2 位会全是 0.00，看不出差别。
									// 「本会话预估」= 上次刷新确认的分摊值 + 此后新增 token 的预估（与卡片同源）
									h(Row, {
										label: "本会话预估",
										value:
											ownEstimate === null
												? formatCost(cost.total, "¥")
												: formatCost(ownEstimate, symbol)
									}),
									h(Row, { label: "未命中输入", value: formatCost(cost.miss, "¥") }),
									h(Row, { label: "缓存命中", value: formatCost(cost.hit, "¥") }),
									h(Row, { label: "输出花费", value: formatCost(cost.output, "¥") }),
									// 累计花费：充值不影响它（只抬锚点），所以不再有"暂停"状态。
									h(Row, {
										label: parallel ? "本会话分摊" : "实际扣费",
										value: !ready
											? "等待余额"
											: typeof ownActual === "number"
												? formatCost(ownActual, symbol)
												: "等首次读数"
									}),
									parallel
										? h(Row, {
												label: "账户级合计",
												value:
													typeof accountTotal === "number"
														? formatCost(accountTotal, symbol)
														: "—"
											})
										: null,
									h(Row, {
										label: "Token 用量",
										value: `${formatTokens(cost.missTokens)} / ${formatTokens(cost.hitTokens)} / ${formatTokens(cost.outputTokens)}`
									}),
									// 分摊权重：只有这一个数决定"本会话分摊"占账户级的多少。
									// 并行时如果这里显示 100%，说明分母只算到了本会话 —— 那分摊值必然等于账户级。
									h(Row, {
										label: "本会话占比",
										value: allTokens > 0 ? `${((ownTokens / allTokens) * 100).toFixed(1)}%` : "—"
									}),
									parallel
										? h(Row, {
												label: "其它会话",
												value: formatCost(otherTokens, "¥")
											})
										: null,
									parallel
										? h(Row, {
												label: "跟踪会话",
												value: `${trackedSessions.length} 个`
											})
										: null
								),
						cost?.unknownModel
							? h("div", { style: hintStyle }, `未知模型「${props.model}」，暂按 ${cost.usingPriceOf} 价格估算。`)
							: null,
						h(
							"div",
							{ style: hintStyle },
							"预估 = token 用量 × 官方价格表（缓存写按未命中价）。实际扣费 = 累计的余额减少量，按会话分别存本地，刷新与切换会话都不丢。识别到充值（余额升幅超过 token 估算上界）时只抬起基线、不打断计数，所以花费持续累计；判错了可以点「我刚充值了」手动纠正。面板 4 位小数，小卡片 2 位。"
						)
					)
				: null;

			return h(
				"div",
				{ style: rootStyle },
				h(
					"div",
					{
						style: hoverSurfaceStyle
					},
					panel,
					badge
				)
			);
		}
		//#endregion

		//#region 余额基线（账户级）
		/** 基线持久化的 localStorage 键（v3 起带成员表）。 */
		const TRACKER_KEY = "dsh-balance-hud:tracker:v4";
		/** 旧键：读到就迁移。 */
		const LEGACY_KEYS = ["dsh-balance-hud:tracker:v3", "dsh-balance-hud:tracker:v2", "dsh-balance-hud:tracker:v1"];
		/** 余额跳增（充值 / 赠金到账）的判定阈值。 */
		const TOPUP_EPSILON = 0.01;
		/** 单条基线的最长保留时间：超过视为陈旧，重新定基。 */
		const TRACKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
		/** 最多保留多少个会话的基线（超出按时间淘汰最旧的）。 */
		const TRACKER_MAX_SESSIONS = 30;
		/** 保留多少条充值事件（用于面板展示与赠金去重）。 */
		const TRACKER_MAX_TOPUPS = 10;
		/**
		 * 判定"余额跳高算不算充值"的精度容差。
		 *
		 * 判据用的是 **token 估算上界**（平台扣的钱不可能超过这段时间 token 按价目表算出的钱），
		 * 所以这里只需要覆盖浮点与分位取整的噪声，不需要留大余量。
		 */
		const TOPUP_TOLERANCE = 0.02;
		/** 识别到充值后的提示停留时间。 */
		const TOPUP_NOTICE_MS = 12000;

		/**
		 * 读基线表：`{ sessions: { [id]: { baseline, lastBalance, spent, ts } } }`。
		 *
		 * 本函数只负责**把 JSON 读出来并做老格式迁移**，不参与任何记账计算；
		 * 账户级口径见下面的 `accountLevelDelta`（各会话 spent 之和）。
		 *
		 * 兼容 v3（`{ sessions: {…} }`）、v2（扁平字典）与 v1（单条记录）。
		 *
		 * @returns 基线表 `{ sessions }`。
		 */
		function readStore() {
			try {
				const raw = globalThis.localStorage?.getItem(TRACKER_KEY);
				if (raw !== null && raw !== undefined) {
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						if (parsed.sessions !== null && typeof parsed.sessions === "object") return parsed;
					}
				}
				// 迁移：v3 已经是 `{ sessions: {…} }`（旧版本的同名键），
				//       v2 是扁平的 `{ [sessionId]: {…} }`，v1 是单条 `{ sessionId, … }`
				for (const key of LEGACY_KEYS) {
					const legacyRaw = globalThis.localStorage?.getItem(key);
					if (legacyRaw === null || legacyRaw === undefined) continue;
					const legacy = JSON.parse(legacyRaw);
					if (legacy === null || typeof legacy !== "object") continue;
					let sessions = {};
					if (typeof legacy.sessionId === "string") {
						// v1：单条
						sessions = { [legacy.sessionId]: { baseline: legacy.baseline, start: legacy.start, ts: legacy.ts } };
					} else if (legacy.sessions !== null && typeof legacy.sessions === "object") {
						// v3：已经是 { sessions: … } 形状，直接拿（保留 spent 等字段）
						sessions = Object.fromEntries(
							Object.entries(legacy.sessions).filter(([, entry]) => typeof entry?.ts === "number")
						);
					} else {
						// v2：扁平字典
						sessions = Object.fromEntries(
							Object.entries(legacy).filter(([, entry]) => typeof entry?.ts === "number")
						);
					}
					if (Object.keys(sessions).length > 0) {
						// 旧的 start 字段在计数器模型里没用了，顺手清掉
						for (const entry of Object.values(sessions)) delete entry.start;
						const migrated = { sessions, topups: Array.isArray(legacy.topups) ? legacy.topups : [] };
						globalThis.localStorage?.removeItem?.(key);
						writeStore(migrated);
						return migrated;
					}
				}
				return { sessions: {} };
			} catch {
				return { sessions: {} };
			}
		}

		/**
		 * 写回基线表（先淘汰过期与超量的记录）。
		 * @param store - 基线表。
		 */
		function writeStore(store) {
			try {
				const now = Date.now();
				const fresh = Object.entries(store.sessions ?? {})
					.filter(([, entry]) => typeof entry?.ts === "number" && now - entry.ts <= TRACKER_MAX_AGE_MS)
					.sort(([, a], [, b]) => b.ts - a.ts)
					.slice(0, TRACKER_MAX_SESSIONS);
				globalThis.localStorage?.setItem(TRACKER_KEY, JSON.stringify({ sessions: Object.fromEntries(fresh) }));
			} catch {
				// localStorage 不可用（隐私模式等）时降级为仅内存，功能不受影响。
			}
		}

		/**
		 * 新建一份基线状态。
		 *
		 * **必须无损**：`readStore()` 与 `loadTracker()` 返回的记录形状要一致，
		 * 否则新增字段会在"读—改—写"之间被静默丢掉。
		 * （曾经因为这里只映射了部分字段，`lastRead` 读不出来，
		 * 于是 `previousBalanceOf` 退化成用事件余额，把真实消费整段吞掉。）
		 *
		 * 字段含义：
		 * - `baseline`：该会话窗口起点的**账户余额**（重锚时会被移动）；
		 * - `lastBalance`：最近一次外部变动后的余额（账户级）；
		 * - `lastRead`：本会话**真正观测到**的余额，下次读数从它继续算；
		 * - `spent`：累计花费计数器，只增不减；
		 * - `ts`：最后一次更新的时间（用于淘汰）。
		 *
		 * @param sessionId - 归属会话。
		 * @param persisted - 从磁盘读回的那一条。
		 * @param ts - 该条的持久化时间。
		 * @returns 记录对象（形状与持久化一致）。
		 */
		function createTracker(sessionId, persisted, ts) {
			const record = { ...(persisted ?? {}) };
			record.sessionId = sessionId;
			if (typeof record.baseline !== "number") record.baseline = undefined;
			if (typeof record.spent !== "number") record.spent = 0;
			record.ts = ts ?? record.ts ?? Date.now();
			return record;
		}

		/**
		 * 取出某个会话的基线（没有则是空基线）。读不出来时返回 null。
		 * @param sessionId - 会话 id。
		 * @returns 基线对象或 null。
		 */
		function loadTracker(sessionId) {
			if (typeof sessionId !== "string") return null;
			const entry = readStore().sessions?.[sessionId];
			if (entry === undefined) return null;
			return createTracker(sessionId, entry, entry.ts);
		}

		/**
		 * 把某个会话的基线合并回磁盘（只动这一条，其它会话原样保留）。
		 * @param tracker - 基线对象。
		 */
		function persistTracker(tracker) {
			if (typeof tracker.sessionId !== "string" || tracker.baseline === undefined) return;
			const store = readStore();
			store.sessions = store.sessions ?? {};
			store.sessions[tracker.sessionId] = {
				baseline: tracker.baseline,
				lastBalance: tracker.last,
				spent: tracker.spent ?? 0,
				ts: tracker.ts
			};
			writeStore(store);
		}

		/**
		 * 记录"某会话被访问过"并抓取它的锚点。
		 *
		 * 首次访问时 `total` 为 null（进程刚起来还没读过余额），此时只登记会话，
		 * 锚点留到第一次读数时再定。
		 *
		 * @param sessionId - 被访问的会话。
		 * @param total - 当前账户余额；尚未读到则传 null。
		 */
		function checkoutSession(sessionId, total) {
			if (typeof sessionId !== "string") return;
			const existing = loadTracker(sessionId);
			if (existing === null) {
				const fresh = createTracker(sessionId, undefined, undefined);
				if (typeof total === "number") {
					fresh.baseline = total;
					fresh.last = total;
				}
				fresh.ts = Date.now();
				persistTracker(fresh);
				return;
			}
			existing.ts = Date.now();
			persistTracker(existing);
		}

		/**
		 * 判定一次余额读数该怎么记账。
		 *
		 * 唯一的判据是 **token 估算上界**，而且它**双向都成立**：平台扣掉的钱
		 * 不可能超过这段时间全部 token 按官方价目表算出来的钱（tokenEstimate）；
		 * 反过来，余额**减少**的量如果超过这个上界，多出来的部分也不可能来自消费。
		 *
		 * ```
		 * 余额升幅 > 上界  →  外部加钱：充值 / 赠金到账 / 账单修正      （topup）
		 * 余额降幅 > 上界  →  外部减钱：赠金过期回收 / 退款 / 账单修正  （expire）
		 * 其余             →  普通消费累计 / 忽略噪声
		 * ```
		 *
		 * 反向那条（`expire`）是**赠金时效性**必需的处理：赠金到期会被平台收回，
		 * 表现为余额凭空下降却没有对应消费。不区分的话这块钱会被记成"本会话花费"，
		 * 而且因为计数器只增不减，错误会一直留在里面。
		 *
		 * 比"拍一个 epsilon"可靠得多：两个方向都不会因为正常波动误判。
		 *
		 * @param previousBalance - 上一次读到的余额（可能是别的会话读的）。
		 * @param balance - 本次余额。
		 * @param tokenEstimate - 期间全部会话的 token 预估花费（保守上界）。
		 * @returns `{ kind, amount }`：kind 为 spend / topup / expire / flat / noise。
		 */
		function classifyRead(previousBalance, balance, tokenEstimate) {
			if (typeof previousBalance !== "number") return { kind: "flat", amount: 0 };
			const delta = balance - previousBalance;
			if (Math.abs(delta) <= 0.0001) return { kind: "noise", amount: 0 };
			const bound = (typeof tokenEstimate === "number" ? tokenEstimate : 0) + TOPUP_TOLERANCE;
			if (delta > 0) return delta > bound ? { kind: "topup", amount: delta } : { kind: "noise", amount: 0 };
			const drop = -delta;
			// 降幅超过上界 → 超出部分是外部减钱（最常见的是赠金过期）
			return drop > bound ? { kind: "expire", amount: drop } : { kind: "spend", amount: drop };
		}

		/**
		/**
		 * 判定一次读数该和**哪个余额**相比。
		 *
		 * 唯一的首选是 `lastRead` —— **本会话上次真正观测到的余额**。
		 * 这一点很关键：外部变动（充值到账 / 赠金过期回收）会改写 `baseline` 与
		 * `lastBalance`（它们是账户级、被事件驱动的），但**绝不会**动 `lastRead`。
		 *
		 * 于是每个会话都天然自愈：
		 * - 别的会话观测到的变动，本会话下次读数仍会看到完整落差，
		 *   于是它自己也能判出这是外部变动，而不会把差额当成消费；
		 * - 本会话自己触发的变动，因为那次读数已经处理过，起点自然推进，不会重复计入。
		 *
		 * 早期版本在这里加过一个"重锚桥"字段来补"变动前未观测的消费"，
		 * 但那个字段同时承担"上次读数"和"事件余额"两种含义，反复出错。
		 * `lastRead` 单独承载一种含义就够了。
		 *
		 * @param entry - 该会话的记录。
		 * @param store - 基线表（迁移过来的老数据可能缺 `lastRead`）。
		 * @returns 上次余额；完全没有可用值时返回 undefined。
		 */
		function previousBalanceOf(entry, store) {
			if (typeof entry.lastRead === "number") return entry.lastRead;
			// 老数据只有事件余额或锚点
			if (typeof entry.lastBalance === "number") return entry.lastBalance;
			if (typeof entry.baseline === "number") return entry.baseline;
			if (typeof store.lastObservedBalance === "number") return store.lastObservedBalance;
			return undefined;
		}

		/**
		 * 给**所有**会话重锚到当前余额 —— **充值到账**与**外部扣减**共用。
		 *
		 * 方向无关：外部变动只改余额、不改花费，所以这里只移动 `baseline` 与
		 * `lastBalance`（两个账户级字段），`spent` 一律原样保留。
		 *
		 * **刻意不动 `lastRead`**：它是"本会话上次真正观测到的余额"，属于会话私有。
		 * 让别的会话下次读数时仍能看到完整落差，从而各自独立地判出这是一次外部变动 ——
		 * 否则它们会把那段差额当成自己的消费。
		 *
		 * @param balance - 变动后的余额。
		 * @param amount - 识别到的变动金额（用于提示）。
		 * @param sessionId - 触发的会话。
		 * @param kind - `topup` 或 `expire`。
		 * @returns 更新后的基线表。
		 */
		function applyExternalChange(balance, amount, sessionId, kind) {
			const store = readStore();
			store.sessions = store.sessions ?? {};
			const now = Date.now();
			for (const entry of Object.values(store.sessions)) {
				entry.baseline = balance;
				entry.lastBalance = balance;
				entry.ts = now;
			}
			store.topups = [{ at: now, amount, sessionId, kind }, ...(store.topups ?? [])].slice(0, TRACKER_MAX_TOPUPS);
			writeStore(store);
			return store;
		}

		/**
		 * 记录一次余额读数并维护计数。
		 *
		 * **核心模型**：余额会因充值跳高，但花费计数**只增不减**。
		 * - 余额下降 → `spent += 降幅`（正常消费）
		 * - 判定为充值 → 只把锚点抬到当前余额，`spent` 不动，继续正常累计
		 *
		 * 于是"充值"从"停摆事件"变成"一次无副作用的重锚"，花费全程正常运行。
		 *
		 * @param sessionId - 读数所属会话。
		 * @param balance - 本次余额。
		 * @param tokenEstimate - 期间全部会话的 token 预估花费（判据上界）。
		 * @returns `{ kind, amount, spent }`：kind 为 spend / topup / flat / noise。
		 */
		function observeRead(sessionId, balance, tokenEstimate) {
			if (typeof sessionId !== "string" || typeof balance !== "number") {
				return { kind: "flat", amount: 0, spent: 0 };
			}
			const store = readStore();
			store.sessions = store.sessions ?? {};
			let entry = store.sessions[sessionId];
			if (entry === undefined) {
				entry = { baseline: balance, lastBalance: balance, lastRead: balance, spent: 0, ts: Date.now() };
				store.sessions[sessionId] = entry;
				writeStore(store);
				return { kind: "flat", amount: 0, spent: 0, store };
			}
			// 上一次读到的余额：本会话自己的 `lastRead`（见 previousBalanceOf）。
			const previous = previousBalanceOf(entry, store);
			const verdict = classifyRead(typeof previous === "number" ? previous : balance, balance, tokenEstimate);
			if (verdict.kind === "topup" || verdict.kind === "expire") {
				// 外部变动（充值到账 / 赠金过期回收）：只移动账户级字段、不动计数。
				// 触发会话自己的 `lastRead` 也在下面推进，所以这次变动不会被重复计入。
				const storeAfter = applyExternalChange(balance, verdict.amount, sessionId, verdict.kind);
				storeAfter.lastObservedBalance = balance;
				const mine = storeAfter.sessions?.[sessionId];
				if (mine) {
					mine.lastRead = balance;
					writeStore(storeAfter);
				}
				return {
					kind: verdict.kind,
					amount: verdict.amount,
					spent: storeAfter.sessions?.[sessionId]?.spent ?? 0,
					store: storeAfter
				};
			}
			if (verdict.kind === "spend") {
				entry.spent = (typeof entry.spent === "number" ? entry.spent : 0) + verdict.amount;
			}
			// 本会话追平到当前余额：推进 `lastRead`，下次从它继续算
			entry.lastRead = balance;
			entry.lastBalance = balance;
			entry.ts = Date.now();
			store.lastObservedBalance = balance;
			writeStore(store);
			return { kind: verdict.kind, amount: verdict.amount, spent: entry.spent, store };
		}

		/**
		 * **本会话**的累计花费：只由"余额下降"累加，充值不会改变它。
		 *
		 * 为什么不能直接用"锚点 − 当前余额"：那样充值会把数字压成 0 或负数，
		 * 只有等消费重新跌到锚点以下才恢复 —— 也就是之前的"充值后暂停"。
		 * 累计计数器没有这个问题：充值只抬锚点，计数照常。
		 *
		 * @param store - 基线表。
		 * @param sessionId - 当前会话。
		 * @returns 金额 / null（还没定锚）。
		 */
		function sessionSpentOf(store, sessionId) {
			const entry = store.sessions?.[sessionId];
			if (entry === undefined || typeof entry.baseline !== "number") return null;
			return typeof entry.spent === "number" ? entry.spent : 0;
		}

		/**
		 * 账户级累计花费：所有已跟踪会话 `spent` 之和。
		 * 仅用于面板参照；卡片不能用它当作"本会话花费"（会污染成同一个数）。
		 *
		 * @param store - 基线表。
		 * @returns 金额 / null（还没有任何会话定锚）。
		 */
		function accountLevelDelta(store) {
			const entries = Object.values(store.sessions ?? {});
			if (entries.length === 0) return null;
			return entries.reduce((total, entry) => total + (typeof entry?.spent === "number" ? entry.spent : 0), 0);
		}

		//#endregion
		//#region 插件体
		/** 依赖的客户端服务：槽位注册与会话 binding。余额走 Host 只读路由，不用 ctx.remote。 */
		const inject = ["slots", "sessions"];
		/**
		 * 注册右下角 HUD。
		 *
		 * 用 `shell.overlay`（框架级浮层，层级在所有列之上、且不受各列滚动容器
		 * 裁剪），组件自己用 `position: fixed` 钉在右下角。
		 *
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			const sessionHook = ctx.slots.hooks?.sessions;
			const activeSessionId = () => {
				try {
					if (typeof sessionHook !== "function") return undefined;
					const rows = Object.values(sessionHook.getSnapshot?.()?.byId ?? {});
					return rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
				} catch {
					return undefined;
				}
			};

			// 初始为空基线。
			
			// 账户级基线状态：锚点表 + 最近余额 + 当前会话。
			const baselineStage = { store: { sessions: {} }, runningBalance: null, activeSession: undefined };

			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{
								name: "shell.overlay",
								id: "balance-hud",
								order: 500,
								inject: () => ({
									ctx,
									sessionId: activeSessionId(),
									model: "deepseek-flash",

									baselineStage,
									/**
									 * 本会话累计花费：只由"余额下降"累加。**充值不会改变它**
									 * （识别到充值只抬锚点，计数照常），所以不会再出现"充值后暂停"。
									 *
									 * @returns 金额 / null（该会话还没定锚）。
									 */
									sessionSpent: () => sessionSpentOf(baselineStage.store, baselineStage.activeSession),
									/** 账户级合计（各会话计数之和），仅作面板参照。 */
									accountTotal: () => accountLevelDelta(baselineStage.store),
									/** 已跟踪的会话（含各会话基线），供分摊时枚举。 */
									trackedSessions: () => Object.keys(baselineStage.store?.sessions ?? {}),
									/**
									 * 读某个会话的 token 成本（预估花费），作为分摊权重的一部分。
									 *
									 * **必须传模型与峰谷**：分母里的其它会话要和被分摊的会话**同一套价格口径**，
									 * 否则不同模型/时段的会话权重不可比。成本本身仍按
									 * 未命中输入 / 缓存命中 / 缓存写 / 输出四类分别计价（见 costOf）。
									 *
									 * 取不到（会话没被 retain / 没有用量）返回 0。
									 *
									 * @param id - 目标会话 id。
									 * @param model - 价格口径用的模型。
									 * @param peak - 是否按峰时价。
									 * @returns 该会话的预估花费（元）。
									 */
									tokensOf: (id, model, peak) => {
										try {
											const usage = ctx.sessions?.binding?.(id)?.session?.projections?.faceOf("tokenUsage")?.getSnapshot();
											const info = costOf(usage, model, peak);
											return info?.total ?? 0;
										} catch {
											return 0;
										}
									},
									/**
									 * 手动兜底：用户点击「我刚充值了」时调用。
									 * 与自动识别同一条路径 —— 只抬锚点、不动计数。
									 *
									 * @param total - 当前余额（没读到则不传）。
									 * @returns 是否记账成功。
									 */
									markTopUp: (total, amount) => {
										if (typeof total !== "number") return false;
										applyExternalChange(
											total,
											typeof amount === "number" ? amount : 0,
											baselineStage.activeSession,
											"topup"
										);
										baselineStage.store = readStore();
										baselineStage.runningBalance = total;
										return true;
									}
								})
							},
							BalanceHud
						)
					),
				"balance-hud: 右下角余额/花费 HUD"
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数随手导出，供离线冒烟测试直接验证（浏览器侧不会用到）。
		exports.__test = { readBalance, costOf, isPeakHour, formatMoney, formatCost, formatCostShort, formatTokens, formatClock, loadTracker, createTracker, checkoutSession, observeRead, classifyRead, applyExternalChange, accountLevelDelta, sessionSpentOf, readStore, writeStore };
		return module.exports;
	}
});

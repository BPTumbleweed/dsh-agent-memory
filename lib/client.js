/**
 * dsh-agent-memory —— 客户端面板（浏览器侧）
 *
 * 在会话头部的视图页签里加一个「记忆」，位置紧随「上下文」（order 30 > 20）。
 * 页签内容用 <iframe> 直接嵌服务端渲染的 /dsh-agent-memory/panel，并把当前主题
 * 通过 ?theme= 传进去 —— iframe 跨源拿不到父页面的主题设置，只能这样同步。
 *
 * 为什么刻意只写这么点：客户端插件 API（插槽 + React 运行时）属于 DSH 内部接口，
 * 是整套方案里最容易被版本升级打断的一层。把 UI 逻辑全部留在服务端页面里，
 * 客户端只负责"注册一个页签 + 一个 iframe + 主题同步"，最坏情况是页签消失，
 * 既不会拖垮 GUI，也不影响记忆库与偏好注入（那两条都不经过这里）。
 */
window.__ModuleLoader__.load({
	id: "dsh-agent-memory",
	factory: (require) => {
		var module = { exports: {} };
		module.exports;
		const react = require("react");

		/** 读出 DSH 当前主题：属性 → class → 实际背景亮度 → 系统偏好。 */
		function detectTheme() {
			try {
				// DSH 的暗色标记是 body[data-ds-dark-theme]（主样式表里就是这个选择器）
				if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return "dark";
				const el = document.documentElement;
				const attr = String(
					el.getAttribute("data-theme") || el.getAttribute("data-color-scheme") || "",
				).toLowerCase();
				if (attr === "dark" || attr === "light") return attr;
				if (el.classList.contains("dark")) return "dark";
				if (el.classList.contains("light")) return "light";
				const bg = getComputedStyle(document.body || el).backgroundColor || "";
				const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
				if (m) {
					const lum = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
					return lum < 128 ? "dark" : "light";
				}
			} catch (e) {}
			try {
				return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			} catch (e) {
				return "light";
			}
		}

		function frame(theme) {
			return react.createElement("iframe", {
				src: "/dsh-agent-memory/panel?theme=" + theme,
				title: "Agent 记忆 · 工作状态",
				style: {
					border: "0",
					width: "100%",
					height: "100%",
					minHeight: "74vh",
					display: "block",
					background: "transparent",
					colorScheme: theme,
				},
			});
		}

		function MemoryPanel() {
			// 主题跟随 DSH：DOM 属性变化 / 系统偏好变化 / 兜底轮询，任一触发就重挂 iframe
			const canHook = typeof react.useState === "function" && typeof react.useEffect === "function";
			if (!canHook) return frame(detectTheme());
			const [theme, setTheme] = react.useState(detectTheme);
			react.useEffect(() => {
				const sync = () => {
					const next = detectTheme();
					setTheme((prev) => (prev === next ? prev : next));
				};
				let obs = null;
				let mq = null;
				let timer = null;
				try {
					obs = new MutationObserver(sync);
					obs.observe(document.documentElement, { attributes: true });
				} catch (e) {}
				try {
					mq = window.matchMedia("(prefers-color-scheme: dark)");
					mq.addEventListener("change", sync);
				} catch (e) {}
				timer = setInterval(sync, 5000);
				return () => {
					try { obs && obs.disconnect(); } catch (e) {}
					try { mq && mq.removeEventListener("change", sync); } catch (e) {}
					clearInterval(timer);
				};
			}, []);
			return frame(theme);
		}

		function apply(ctx) {
			try {
				if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("conversation.view", () =>
					ctx.slots.register(
						{
							name: "conversation.view",
							id: "agent-memory",
							order: 30,
							label: () => "记忆",
						},
						(props) => react.createElement(MemoryPanel, props),
					),
				);
			} catch (err) {
				// 注册失败只告警：绝不让一个可选页签影响会话本体
				try {
					console.warn("[dsh-agent-memory] 客户端页签注册失败（已忽略）：", err);
				} catch (e) {}
			}
		}

		module.exports = {
			name: "dsh-agent-memory",
			inject: ["slots"],
			apply,
		};
		return module.exports;
	},
});

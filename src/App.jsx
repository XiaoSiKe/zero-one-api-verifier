import { useEffect, useRef, useState } from 'react';
import EchoText from './EchoText';
import SpecularButton from './SpecularButton';
import ThreadsBackground from './ThreadsBackground';

const PRODUCT_NAME = '零一智鉴 · API 真测雷达';
const SLOGAN = '从零到一，让每一个接口有据可鉴！';
const API_TEST_URL = '/app';
const LICENSE_URL = 'https://github.com/XiaoSiKe/zero-one-api-verifier/blob/main/zero-one-api-verifier/LICENSE';
const ECHO_TEXT_PROPS = {
  echoes: 12,
  lag: 0.24,
  offset: 36,
  direction: 'right',
  fade: 0.72,
  blur: 3,
  tint: '#a3a3a3',
  mode: 'both',
  cursorRadius: 320,
  duration: 900,
  ease: 'ease-out',
  fontSize: 'clamp(3rem, 9vw, 7rem)',
  fontWeight: 800,
  color: '#f5f5f5',
};
const SPECULAR_BUTTON_PROPS = {
  size: 'lg',
  radius: 18,
  tint: '#ffffff',
  tintOpacity: 0,
  blur: 0,
  textColor: '#f5f5f5',
  lineColor: '#ffffff',
  baseColor: '#525252',
  intensity: 1,
  shineSize: 10,
  shineFade: 40,
  thickness: 1,
  speed: 0.35,
  followMouse: true,
  proximity: 250,
  autoAnimate: false,
};

export default function App() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const headerRef = useRef(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setIsScrolled(window.scrollY > 24);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!isNavOpen) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsNavOpen(false);
    };
    const closeOnOutsideClick = (event) => {
      if (!headerRef.current?.contains(event.target)) setIsNavOpen(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsideClick);
    };
  }, [isNavOpen]);

  const showTrustSection = () => {
    const target = document.getElementById('trust-title');
    if (!target) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
    setIsNavOpen(false);
  };

  return (
    <div className="homepage">
      <a className="skip-link" href="#hero-title">跳到主要内容</a>

      <ThreadsBackground />

      <header ref={headerRef} className={`site-header${isScrolled ? ' is-scrolled' : ''}`}>
        <div className="brand">
          <div className="brand-logo" aria-hidden="true">
            <img src="/lingyi-logo.jpg" alt="" />
          </div>
          <strong>
            <span className="brand-name-full">{PRODUCT_NAME}</span>
            <span className="brand-name-short">零一智鉴</span>
          </strong>
        </div>

        <button
          className="home-nav-toggle"
          type="button"
          aria-label={isNavOpen ? '关闭菜单' : '打开菜单'}
          aria-expanded={isNavOpen}
          aria-controls="primary-navigation"
          onClick={() => setIsNavOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav
          id="primary-navigation"
          className={`primary-nav${isNavOpen ? ' is-open' : ''}`}
          aria-label="主导航"
          onClick={() => setIsNavOpen(false)}
        >
          <a href="#hero-title">首页</a>
          <a href="/claude">Claude</a>
          <a href="/openai">OpenAI</a>
          <a href="/gemini">Gemini</a>
          <a href="/leaderboard">红黑榜</a>
          <a href="/faq">常见问题</a>
          <a
            className="nav-github"
            href="https://github.com/XiaoSiKe/zero-one-api-verifier"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 GitHub 查看源码"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="nav-github-label">GitHub 源码</span>
          </a>
          <a className="nav-action" href={API_TEST_URL}>开始 API 真测</a>
        </nav>
      </header>

      <main className="hero" aria-labelledby="hero-title">
        <div
          className="hero-stage"
          style={{ width: '100%', height: '100dvh', position: 'relative' }}
        >
          <div className="hero-vignette" aria-hidden="true" />

          <div className="hero-content">
            <p className="release-pill">
              <b>01</b>
              <span>API TEST RADAR</span>
            </p>

            <h1 id="hero-title" className="echo-viewport title-echo" aria-label={PRODUCT_NAME}>
              <span className="echo-scale">
                <EchoText
                  {...ECHO_TEXT_PROPS}
                  text={PRODUCT_NAME}
                />
              </span>
            </h1>

            <p className="echo-viewport slogan-echo">
              <span className="echo-scale">
                <EchoText
                  {...ECHO_TEXT_PROPS}
                  text={SLOGAN}
                />
              </span>
            </p>

            <a
              className="hero-license-link"
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              License · AGPL-3.0-or-later
            </a>

            <div className="hero-proof">
              <p className="hero-proof-summary">
                <strong>零一智鉴</strong>用服务端加密签名与多维行为指纹，<br />
                <strong>1 分钟</strong>验证 Claude / GPT / Gemini 是否真实透传。<br />
                无需注册，API key 不留存，代码开源。
              </p>
              <p className="hero-proof-meta">
                已检测 <strong>3 个</strong>协议 · <strong>12 项</strong>独立维度 · <strong>30-75 秒</strong>出报告 · 报告 URL 永久可分享
              </p>
            </div>

            <div className="hero-actions">
              <SpecularButton
                {...SPECULAR_BUTTON_PROPS}
                className="hero-button"
                onClick={() => { window.location.href = API_TEST_URL; }}
              >
                开始 API 真测
              </SpecularButton>
              <SpecularButton
                {...SPECULAR_BUTTON_PROPS}
                className="hero-button"
                onClick={showTrustSection}
              >
                关于零一
              </SpecularButton>
            </div>
          </div>
        </div>

        <div className="home-sections">
          <section className="home-section home-trust-section" id="trust" aria-labelledby="trust-title">
            <h2 className="home-flow-title" id="trust-title" tabIndex="-1">
              100% 开源 · 评分算法可逐行审计
            </h2>

            <div className="home-trust-panel">
              <p className="home-trust-intro">
                零一智鉴的本质是「<strong>把 API key 交给我们检测中转站</strong>」 — 这件事的基础是<strong>信任</strong>。<br />
                所以我们把所有评分逻辑、key 处理代码全部公开,任何人可以审计。这是闭源工具永远做不到的承诺。
              </p>

              <div className="home-trust-cards">
                <article className="home-trust-card">
                  <span className="home-card-index" aria-hidden="true">01</span>
                  <h3>评分算法公开</h3>
                  <p>12 项 detector 怎么打分、贝叶斯排名公式、tokenizer 校准 — 全在 GitHub,无黑盒。</p>
                  <SpecularButton
                    {...SPECULAR_BUTTON_PROPS}
                    size="md"
                    className="home-trust-button"
                    onClick={() => window.open(
                      'https://github.com/XiaoSiKe/zero-one-api-verifier/tree/main/zero-one-api-verifier/src/relay_detector',
                      '_blank',
                      'noopener,noreferrer',
                    )}
                  >
                    查看检测器源码 →
                  </SpecularButton>
                </article>

                <article className="home-trust-card">
                  <span className="home-card-index" aria-hidden="true">02</span>
                  <h3>API key 不落盘<br /><em>可代码证明</em></h3>
                  <p>
                    SECURITY.md 列出每条 key 处理承诺,每条都标了代码位置 — 你可以
                    <code>grep</code> 验证。不是“我们说不偷”,是“代码不让偷”。
                  </p>
                  <SpecularButton
                    {...SPECULAR_BUTTON_PROPS}
                    size="md"
                    className="home-trust-button"
                    onClick={() => window.open(
                      'https://github.com/XiaoSiKe/zero-one-api-verifier/blob/main/zero-one-api-verifier/SECURITY.md',
                      '_blank',
                      'noopener,noreferrer',
                    )}
                  >
                    查看安全策略 →
                  </SpecularButton>
                </article>

                <article className="home-trust-card">
                  <span className="home-card-index" aria-hidden="true">03</span>
                  <h3>支持完全自托管</h3>
                  <p>
                    不放心 SaaS?<code>git clone</code> 到自己机器跑,API key 永远不离开你的网络。
                    AGPL-3.0-or-later 许可证保证 fork 出去的修改也必须开源。
                  </p>
                  <SpecularButton
                    {...SPECULAR_BUTTON_PROPS}
                    size="md"
                    className="home-trust-button"
                    onClick={() => window.open(
                      'https://github.com/XiaoSiKe/zero-one-api-verifier#readme',
                      '_blank',
                      'noopener,noreferrer',
                    )}
                  >
                    自托管指南 →
                  </SpecularButton>
                </article>
              </div>
            </div>
          </section>

          <section className="home-section home-how-section" aria-labelledby="how-title">
            <h2 className="home-flow-title" id="how-title">怎么用?三步 60 秒</h2>
            <ol className="home-how-steps">
              <li>
                <span className="home-step-number">1</span>
                <div>
                  <h3>填中转站地址 + API key</h3>
                </div>
              </li>
            </ol>

            <div className="home-protocol-grid" role="region" aria-label="支持的检测协议">
              <article className="home-protocol-card">
                <div className="home-protocol-top">
                  <span className="home-protocol-kicker">Claude</span>
                  <span className="home-tier-badge home-tier-crypto">加密级验证</span>
                </div>
                <h2>Claude API 中转站检测</h2>
                <p>
                  12 项检测,核心是 thinking signature 加密签名 — 这是 Anthropic 服务端真实加密产物
                  (500-2000 字符),中转站理论上无法伪造;Token 用量检查会额外识别 usage 虚报风险。
                </p>
                <SpecularButton
                  {...SPECULAR_BUTTON_PROPS}
                  size="md"
                  className="home-protocol-button"
                  onClick={() => { window.location.href = '/app/claude'; }}
                >
                  检测 Claude 中转站 →
                </SpecularButton>
              </article>

              <article className="home-protocol-card">
                <div className="home-protocol-top">
                  <span className="home-protocol-kicker">OpenAI</span>
                  <span className="home-tier-badge home-tier-behavioral">行为/协议级</span>
                </div>
                <h2>OpenAI 中转站检测</h2>
                <p>
                  8 项检测覆盖 Chat Completions 协议合规、function calling、structured output、
                  流式一致性。能识别中转站把 GPT 请求偷偷转给 Claude / Gemini 后端的「换芯」行为。
                </p>
                <SpecularButton
                  {...SPECULAR_BUTTON_PROPS}
                  size="md"
                  className="home-protocol-button"
                  onClick={() => { window.location.href = '/app/openai'; }}
                >
                  检测 OpenAI 中转站 →
                </SpecularButton>
              </article>

              <article className="home-protocol-card">
                <div className="home-protocol-top">
                  <span className="home-protocol-kicker">Gemini</span>
                  <span className="home-tier-badge home-tier-protocol">协议级</span>
                </div>
                <h2>Gemini 中转站检测</h2>
                <p>
                  7 项检测覆盖 Gemini OpenAI 兼容协议、function calling、structured output、流式一致性
                  和 usage 字段。适配 Gemini 3 thinking-by-default 模型的特殊处理。
                </p>
                <SpecularButton
                  {...SPECULAR_BUTTON_PROPS}
                  size="md"
                  className="home-protocol-button"
                  onClick={() => { window.location.href = '/app/gemini'; }}
                >
                  检测 Gemini 中转站 →
                </SpecularButton>
              </article>
            </div>


            <ol className="home-how-steps home-how-steps-continuation" start={2}>
              <li>
                <span className="home-step-number">2</span>
                <div>
                  <h3>点「开始检测」,等 30-70 秒</h3>
                  <p>
                    零一智鉴并发跑 7-10 项检测,实时显示进度。期间消耗的 token 由你的 key 支付
                    (Haiku 约 $0.012,GPT-4o-mini 约 $0.005)。
                  </p>
                </div>
              </li>
              <li>
                <span className="home-step-number">3</span>
                <div>
                  <h3>看报告,重点看警告与未通过项</h3>
                  <p>
                    总分 ≥85 优秀 / 70-84 通过 / 50-69 存在风险 / &lt;50 未达标。Claude 重点看 thinking signature
                    是否 100 分;OpenAI 看 usage 字段有没有 Claude / Gemini 残留。
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <section className="home-note" aria-labelledby="protocol-note-title">
            <h2 className="home-flow-title" id="protocol-note-title">不同协议的 100 分含义不同</h2>
            <p>
              Claude 的 100 分包含<strong>加密级</strong> thinking signature 验证(Anthropic 服务端签名,中转站不可伪造);
              OpenAI / Gemini 因为没有同等级的服务端签名机制,验证强度只到<strong>行为级 / 协议级</strong>。
              每份报告页顶部都会明确标注本次检测属于哪一级,避免把协议兼容性误读成加密级真伪证明。
              完整说明见 <a href="/app/faq">常见问题</a>。
            </p>
          </section>
        </div>
      </main>

      <footer className="home-footer">
        <div className="home-footer-inner">
          <div className="home-footer-brand">
            <strong>零一智鉴 · API 真测雷达</strong>
            <p>
              从零到一，让每一个接口有据可鉴！<br />
              代码完全开源，API key 永不落盘。
            </p>
          </div>

          <div className="home-footer-links">
            <div className="home-footer-column">
              <h3>项目</h3>
              <ul>
                <li><a href="https://github.com/XiaoSiKe/zero-one-api-verifier" target="_blank" rel="noopener noreferrer">GitHub 源码</a></li>
                <li><a href="https://github.com/XiaoSiKe/zero-one-api-verifier/blob/main/zero-one-api-verifier/LICENSE" target="_blank" rel="noopener noreferrer">License (AGPL-3.0-or-later)</a></li>
                <li><a href="https://github.com/XiaoSiKe/zero-one-api-verifier/blob/main/zero-one-api-verifier/SECURITY.md" target="_blank" rel="noopener noreferrer">安全策略</a></li>
                <li><a href="https://github.com/XiaoSiKe/zero-one-api-verifier/blob/main/zero-one-api-verifier/CONTRIBUTING.md" target="_blank" rel="noopener noreferrer">贡献指南</a></li>
              </ul>
            </div>

            <div className="home-footer-column">
              <h3>工具</h3>
              <ul>
                <li><a href="/claude">Claude 检测</a></li>
                <li><a href="/openai">OpenAI 检测</a></li>
                <li><a href="/gemini">Gemini 检测</a></li>
                <li><a href="/leaderboard">中转站红黑榜</a></li>
              </ul>
            </div>

            <div className="home-footer-column">
              <h3>资源</h3>
              <ul>
                <li><a href="/faq">常见问题</a></li>
                <li><a href="/leaderboard">检测历史排行</a></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="home-footer-copyright">
          <span>© 零一智鉴 · API 真测雷达 · AGPL-3.0-or-later</span>
          <a
            href="https://github.com/XiaoSiKe/zero-one-api-verifier"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 GitHub 查看零一智鉴源码"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span>XiaoSiKe/zero-one-api-verifier</span>
          </a>
        </div>
      </footer>
    </div>
  );
}

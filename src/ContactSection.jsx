import BorderGlow from './BorderGlow';
import './ContactSection.css';

export default function ContactSection() {
  return (
    <section className="home-section home-contact" id="contact" aria-labelledby="contact-title">
      <h2 className="home-flow-title" id="contact-title" tabIndex={-1}>
        联系与合作
      </h2>
      <div className="home-contact-intro">
        <p>欢迎联系我，聊聊你的需求与合作设想。</p>
      </div>
      <div className="home-contact-qq-reveal">
        <BorderGlow className="home-contact-qq-glow">
          <aside className="home-contact-qq" aria-label="QQ 联系方式">
            <div className="home-contact-qr-frame">
              <img src="/qq-qr.png" alt="零一扬 QQ 二维码" width="920" height="920" loading="lazy" />
            </div>
          </aside>
        </BorderGlow>
      </div>
    </section>
  );
}

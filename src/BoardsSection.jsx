import { useEffect, useState } from 'react';
import './BoardsSection.css';
import SpecularButton from './SpecularButton';

const SLOTS = Array.from({ length: 8 }, (_, index) => index + 1);

function PlacementGrid({ prefix, label, placements }) {
  return (
    <div className="home-board-grid" aria-label={`${label}广告位`}>
      {SLOTS.map((number) => {
        const code = `${prefix}${number}`;
        const placement = placements[code];
        const images = placement?.image_urls || (placement?.image_url ? [placement.image_url] : []);
        return (
        <a className={`home-board-slot${images.length ? ' has-banner' : ''}${images.length === 2 ? ' has-rotation' : ''}`} href={placement ? (placement.tracking_url || placement.url) : '/partner/register'}
          target={placement ? '_blank' : undefined} rel={placement ? 'noopener noreferrer' : undefined}
          aria-label={placement ? `${code} 广告位：${placement.name}` : `${code} 广告位，申请展示`}
          key={code}>
          {images.map((url, index) => <img className={`home-board-slot-image is-image-${index + 1}`} src={url} alt="" loading="lazy" key={url} />)}
          <span className="home-board-slot-copy">
            <strong>{placement ? placement.name : `${code} · 优选横幅`}</strong>
            <span>{placement ? placement.domain : '广告位招商中'}</span>
          </span>
          <span className="home-board-slot-badge">广告位 · {code}</span>
        </a>
      );})}
    </div>
  );
}

export default function BoardsSection({ specularProps, onContact }) {
  const [placements, setPlacements] = useState({});

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ad-slots', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : { slots: {} })
      .then((data) => setPlacements(data.slots || {}))
      .catch(() => { /* Keep clearly marked vacancies if the service is unavailable. */ });
    return () => controller.abort();
  }, []);

  return (
    <section className="home-section home-boards" id="boards" aria-labelledby="home-boards-title">
      <h2 className="home-flow-title" id="home-boards-title" tabIndex={-1}>赞助与靠谱榜单</h2>
      <div className="home-board-group">
        <h3>赞助置顶榜</h3>
        <PlacementGrid prefix="S" label="赞助置顶榜" placements={placements} />
      </div>
      <div className="home-board-group">
        <h3>靠谱精选榜</h3>
        <PlacementGrid prefix="T" label="靠谱精选榜" placements={placements} />
      </div>
      <div className="hero-actions home-board-actions">
        <SpecularButton {...specularProps} className="hero-button" onClick={() => { window.location.href = '/leaderboard'; }}>
          API 红黑榜
        </SpecularButton>
        <SpecularButton {...specularProps} className="hero-button" onClick={() => { window.location.href = '/partner/register'; }}>
          我是站长 · 申请收录
        </SpecularButton>
        <SpecularButton {...specularProps} className="hero-button" onClick={onContact}>
          联系与合作
        </SpecularButton>
      </div>
    </section>
  );
}

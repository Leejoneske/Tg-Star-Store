import { useState } from 'react';

const ICON_ZOOM = 1.5;

function IconSlot({ src, label, size }: { src: string; label: string; size: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(4, size * 0.25),
          border: '1px dashed #c7c9cf',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.max(7, size * 0.32),
          color: '#9a9ca3',
          fontFamily: 'sans-serif',
          lineHeight: 1,
        }}
        title={`${label} icon failed to load from ${src}`}
      >
        {label[0]}
      </div>
    );
  }

  return (
    <div style={{ width: size, height: size, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img
        src={src}
        alt={label}
        width={Math.round(size * ICON_ZOOM)}
        height={Math.round(size * ICON_ZOOM)}
        style={{ display: 'block', flexShrink: 0 }}
        onError={() => {
          console.error(`[icons] ${label} icon failed to load from ${src} — file missing at that exact path, or it isn't valid image content.`);
          setFailed(true);
        }}
      />
    </div>
  );
}

export function TelegramStarIcon({ size = 24 }: { size?: number }) {
  return <IconSlot src={`${import.meta.env.BASE_URL}Star.png`} label="Star" size={size} />;
}

export function TelegramPremiumIcon({ size = 24 }: { size?: number }) {
  return <IconSlot src={`${import.meta.env.BASE_URL}Premium.png`} label="Premium" size={size} />;
}


export function TelegramStarIcon({ size = 24 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}Star.svg`}
      alt="Star"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

export function TelegramPremiumIcon({ size = 24 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}Premium.svg`}
      alt="Premium"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

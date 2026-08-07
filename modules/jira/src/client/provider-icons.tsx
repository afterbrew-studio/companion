/**
 * Atlassian's Jira mark, inline so an air-gapped instance draws it like any
 * other pixel it ships. It is Atlassian's trademark, used only to identify
 * their integration. Gradient ids are module-scoped: two inline SVGs sharing an
 * id in one document resolve to whichever the browser saw first.
 */
export function JiraMark(): JSX.Element {
  return (
    <svg
      className="size-5"
      viewBox="0 -30.632388516510233 255.324 285.95638851651023"
      role="img"
      aria-label="Jira"
    >
      <linearGradient id="jira-mark-base">
        <stop offset=".18" stopColor="#0052cc" />
        <stop offset="1" stopColor="#2684ff" />
      </linearGradient>
      <linearGradient
        id="jira-mark-mid"
        x1="98.031%"
        x2="58.888%"
        xlinkHref="#jira-mark-base"
        y1=".161%"
        y2="40.766%"
      />
      <linearGradient
        id="jira-mark-low"
        x1="100.665%"
        x2="55.402%"
        xlinkHref="#jira-mark-base"
        y1=".455%"
        y2="44.727%"
      />
      <path
        d="M244.658 0H121.707a55.502 55.502 0 0 0 55.502 55.502h22.649V77.37c.02 30.625 24.841 55.447 55.466 55.467V10.666C255.324 4.777 250.55 0 244.658 0z"
        fill="#2684ff"
      />
      <path
        d="M183.822 61.262H60.872c.019 30.625 24.84 55.447 55.466 55.467h22.649v21.938c.039 30.625 24.877 55.43 55.502 55.43V71.93c0-5.891-4.776-10.667-10.667-10.667z"
        fill="url(#jira-mark-mid)"
      />
      <path
        d="M122.951 122.489H0c0 30.653 24.85 55.502 55.502 55.502h22.72v21.867c.02 30.597 24.798 55.408 55.396 55.466V133.156c0-5.891-4.776-10.667-10.667-10.667z"
        fill="url(#jira-mark-low)"
      />
    </svg>
  );
}

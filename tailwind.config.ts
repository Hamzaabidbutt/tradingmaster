import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          950: "#05070d",
          900: "#090c15",
          850: "#0d1120",
          800: "#111629",
          700: "#1a2138",
        },
        bull: {
          DEFAULT: "#00e5a0",
          dim: "#0d9d74",
          glow: "rgba(0,229,160,0.35)",
        },
        bear: {
          DEFAULT: "#ff4d6d",
          dim: "#b53152",
          glow: "rgba(255,77,109,0.35)",
        },
        neon: {
          cyan: "#22d3ee",
          violet: "#a78bfa",
          amber: "#fbbf24",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.45)",
        "neon-bull": "0 0 18px rgba(0,229,160,0.25)",
        "neon-bear": "0 0 18px rgba(255,77,109,0.25)",
      },
      backdropBlur: {
        xs: "2px",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4,0,0.6,1) infinite",
        "fade-in": "fadeIn 0.4s ease-out",
        "slide-up": "slideUp 0.35s ease-out",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Shared accent color for the project — represents the "live
        // direct connection" between two peers. Used sparingly.
        link: {
          DEFAULT: '#22d3ee', // cyan-400
          dim: '#0e7490', // cyan-700
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

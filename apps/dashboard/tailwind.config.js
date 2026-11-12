/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const { createGlobPatternsForDependencies } = require('@nx/react/tailwind')
const { join } = require('path')
const plugin = require('tailwindcss/plugin')

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    join(__dirname, '{src,pages,components,app}/**/*!(*.spec).{ts,tsx,html}'),
    ...createGlobPatternsForDependencies(__dirname),
  ],
  theme: {
    extend: {
      screens: {
        xs: '480px',
      },
      fontFamily: {
        // Shared with native CSS and canvas consumers in index.css.
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
        display: ['var(--font-sans)'],
      },
      fontSize: {
        // The console's type scale — six steps, nothing in between. Arbitrary
        // `text-[Npx]` values had grown to twenty-one distinct sizes, ten of
        // them within a 5px band; nothing on a page could line up with anything.
        // Line heights are whole pixels: a ratio such as 1.15 made the page title 32.2px
        // tall, which pushed every row below it onto a fractional pixel and blurred 1px rules.
        label: ['10px', { lineHeight: '1.2', letterSpacing: '0.12em' }],
        meta: ['12px', { lineHeight: '18px' }],
        body: ['13px', { lineHeight: '20px' }],
        em: ['15px', { lineHeight: '1.4' }],
        section: ['20px', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        page: ['28px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        // Square corners are a load-bearing part of the design; only pills/dots stay round.
        none: '0',
        sm: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
        full: '9999px',
      },
      boxShadow: {
        // Theme-aware floating-surface elevation (see --shadow-card in index.css)
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          // Fill for buttons that carry white text; dark enough for 4.5:1 in both themes.
          solid: 'hsl(var(--destructive-solid))',
          foreground: 'hsl(var(--destructive-foreground))',
          background: 'hsl(var(--destructive-background))',
          separator: 'hsl(var(--destructive-separator))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          background: 'hsl(var(--warning-background))',
          separator: 'hsl(var(--warning-separator))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          background: 'hsl(var(--success-background))',
          separator: 'hsl(var(--success-separator))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
          background: 'hsl(var(--info-background))',
          separator: 'hsl(var(--info-separator))',
        },
        border: {
          DEFAULT: 'hsl(var(--border))',
          hover: 'hsl(var(--border-hover))',
          selected: 'hsl(var(--border-selected))',
        },
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [
    require('tailwind-scrollbar'),
    require('tailwindcss-animate'),
    plugin(function ({ addVariant }) {
      addVariant('aria-invalid', '&[aria-invalid="true"]')
    }),
  ],
}

export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-void/60 border-b border-border">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="/" className="font-mono text-xl font-bold text-glow tracking-tight">
          engrams
        </a>
        <nav className="flex items-center gap-2 sm:gap-4">
          <a
            href="/setup"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Setup Guide
          </a>
          <a
            href="https://github.com/Sunrise-Labs-Dot-AI/engrams"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://app.getengrams.com/sign-in"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Sign In
          </a>
          <a
            href="https://app.getengrams.com/sign-up"
            className="btn-glow text-sm !py-1.5 !px-4"
          >
            Sign Up
          </a>
        </nav>
      </div>
    </header>
  );
}

# Homebrew formula TEMPLATE for the shelf CLI.
#
# This is a template — the release pipeline (.github/workflows/release.yml)
# renders it (substituting {{VERSION}} and the per-platform {{URL_*}} /
# {{SHA_*}} pairs) and pushes the result to amitray007/homebrew-tap as
# Formula/shelf.rb. Do NOT hand-edit the rendered formula in the tap — this
# template is the source.
#
# Install (once released):
#   brew tap amitray007/tap
#   brew install amitray007/tap/shelf
#
# Tarballs are hosted on the PUBLIC homebrew-tap's own release (mirroring the
# silo pattern), so brew install works without auth regardless of whether the
# shelf source repo is public or private. Each tarball carries the platform's
# own prebuilt keyring binary, so --store-token-from-env stores credentials in
# the macOS Keychain or the Linux Secret Service out of the box.
class Shelf < Formula
  desc "Publish, version, inspect, and share Shelf artifacts from the terminal"
  homepage "https://github.com/amitray007/shelf"
  version "{{VERSION}}"
  license "MIT"

  depends_on "node"

  on_macos do
    on_arm do
      url "{{URL_DARWIN_ARM64}}"
      sha256 "{{SHA_DARWIN_ARM64}}"
    end
    on_intel do
      url "{{URL_DARWIN_X64}}"
      sha256 "{{SHA_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "{{URL_LINUX_ARM64_GNU}}"
      sha256 "{{SHA_LINUX_ARM64_GNU}}"
    end
    on_intel do
      url "{{URL_LINUX_X64_GNU}}"
      sha256 "{{SHA_LINUX_X64_GNU}}"
    end
  end

  def install
    # Tarball contains dist/ + node_modules/ + package.json. Install into
    # libexec, then expose a launcher that runs the bundle with Homebrew's
    # node.
    libexec.install Dir["*"]
    (bin/"shelf").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/shelf.js" "$@"
    SH
    chmod 0555, bin/"shelf"
  end

  test do
    assert_match "Publish, version, inspect, and share", shell_output("#{bin}/shelf --help")
    assert_match version.to_s, shell_output("#{bin}/shelf --version")
  end
end

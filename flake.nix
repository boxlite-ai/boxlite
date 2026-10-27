# Nix dev shell for building BoxLite from source: `nix develop -c make cli`.
# Community-maintained, x86_64 Linux only. Mirrors scripts/setup/setup-ubuntu.sh;
# Rust stays on rustup so it follows rust-toolchain.toml like CI.
{
  description = "BoxLite development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      # libgvproxy-sys links libresolv statically; a dir holding only that archive
      # keeps the rest of glibc.static off the dynamic link path.
      resolvDir = pkgs.runCommand "libresolv-static" { } ''
        mkdir -p $out && ln -s ${pkgs.glibc.static}/lib/libresolv.a $out/
      '';
      # A real musl toolchain: nixpkgs musl-gcc wraps the glibc gcc and fails on
      # -latomic_asneeded. Scripts expect x86_64-linux-musl-* and musl-gcc names.
      muslCC = pkgs.pkgsCross.musl64.stdenv.cc;
      muslAlias = pkgs.runCommand "musl-alias" { } ''
        mkdir -p $out/bin
        for t in ${muslCC}/bin/x86_64-unknown-linux-musl-*; do
          ln -s $t $out/bin/x86_64-linux-musl-''${t##*/x86_64-unknown-linux-musl-}
        done
        ln -s ${muslCC}/bin/x86_64-unknown-linux-musl-gcc $out/bin/musl-gcc
      '';
    in
    {
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = with pkgs; [
          rustup gcc gnumake git curl wget file pkg-config patchelf
          openssl gperf
          python3 python3Packages.pip python3Packages.pyelftools
          go
          llvm libclang
          flex bison bc elfutils
          meson ninja libcap
          protobuf cmake
        ];
        LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
        # Static glibc only for -static links; as a package it breaks dynamic ones.
        LIBRARY_PATH = "${pkgs.glibc.static}/lib";
        BOXLITE_LIBRESOLV_DIR = "${resolvDir}";
        shellHook = ''
          # musl only via PATH aliases; as a package it would leak into host gcc links.
          export PATH="''${CARGO_HOME:-$HOME/.cargo}/bin:${muslAlias}/bin:$PATH"
        '';
      };
    };
}

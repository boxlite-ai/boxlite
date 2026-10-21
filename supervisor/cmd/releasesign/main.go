// releasesign creates the supervisor release key and signs release binaries.
//
//	releasesign -key ~/.config/microcloud/release-ed25519 -gen   create the key (once), print the public key
//	releasesign -key <path> -pub                                print the public key
//	releasesign -key <path> bin/supervisor-linux-amd64 …        write <file>.sig next to each file
//
// The private key stays on the build machine. The public key is compiled into the
// supervisor (privilege.ReleasePublicKey), so a Box's launcher accepts a new
// supervisor only if it was signed here, even if the control plane serving it is
// compromised. A signature covers the SHA-256 digest of the file.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func main() {
	keyPath := flag.String("key", "", "path of the private key file (base64 ed25519 seed)")
	gen := flag.Bool("gen", false, "create the key if it does not exist")
	pub := flag.Bool("pub", false, "print the public key")
	flag.Parse()
	if *keyPath == "" {
		fail("-key is required")
	}
	if *gen {
		if _, err := os.Stat(*keyPath); os.IsNotExist(err) {
			_, priv, err := ed25519.GenerateKey(rand.Reader)
			check(err)
			check(os.MkdirAll(filepath.Dir(*keyPath), 0o700))
			check(os.WriteFile(*keyPath, []byte(base64.StdEncoding.EncodeToString(priv.Seed())+"\n"), 0o600))
		}
	}
	priv := load(*keyPath)
	if *gen || *pub {
		fmt.Println(base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)))
	}
	for _, file := range flag.Args() {
		f, err := os.Open(file)
		check(err)
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		check(err)
		sig := ed25519.Sign(priv, h.Sum(nil))
		check(os.WriteFile(file+".sig", []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644))
	}
}

func load(path string) ed25519.PrivateKey {
	raw, err := os.ReadFile(path)
	check(err)
	seed, err := base64.StdEncoding.DecodeString(string(trim(raw)))
	check(err)
	if len(seed) != ed25519.SeedSize {
		fail(fmt.Sprintf("%s does not hold an ed25519 seed", path))
	}
	return ed25519.NewKeyFromSeed(seed)
}

func trim(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r' || b[len(b)-1] == ' ') {
		b = b[:len(b)-1]
	}
	return b
}

func check(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "releasesign:", msg)
	os.Exit(1)
}

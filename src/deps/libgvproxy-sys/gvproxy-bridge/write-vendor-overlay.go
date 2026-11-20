//go:build ignore

// Generate the Go build overlay for the patched copy of a vendored module.
package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 3 {
		log.Fatal("expected original and patched module directories")
	}
	original, patched := os.Args[1], os.Args[2]
	overlay := struct{ Replace map[string]string }{make(map[string]string)}
	err := filepath.WalkDir(patched, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, err := filepath.Rel(patched, path)
		if err != nil {
			return err
		}
		source := filepath.Join(original, relative)
		originalContent, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		patchedContent, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(originalContent, patchedContent) {
			overlay.Replace[source] = path
		}
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(overlay); err != nil {
		log.Fatal(err)
	}
}

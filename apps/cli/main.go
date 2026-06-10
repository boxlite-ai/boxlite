// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"os"

	log "github.com/sirupsen/logrus"

	"github.com/boxlite-ai/boxlite/cli/cmd"
	"github.com/boxlite-ai/boxlite/cli/cmd/auth"
	"github.com/boxlite-ai/boxlite/cli/cmd/mcp"
	"github.com/boxlite-ai/boxlite/cli/cmd/organization"
	"github.com/boxlite-ai/boxlite/cli/cmd/box"
	"github.com/boxlite-ai/boxlite/cli/cmd/volume"
	"github.com/boxlite-ai/boxlite/cli/internal"
	"github.com/joho/godotenv"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:               "boxlite",
	Short:             "BoxLite CLI",
	Long:              "Command line interface for BoxLite Boxes",
	DisableAutoGenTag: true,
	SilenceUsage:      true,
	SilenceErrors:     true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

func init() {
	rootCmd.AddGroup(&cobra.Group{ID: internal.USER_GROUP, Title: "User"})
	rootCmd.AddGroup(&cobra.Group{ID: internal.BOX_GROUP, Title: "Box"})

	rootCmd.AddCommand(auth.LoginCmd)
	rootCmd.AddCommand(auth.LogoutCmd)
	rootCmd.AddCommand(box.BoxCmd)
	rootCmd.AddCommand(volume.VolumeCmd)
	rootCmd.AddCommand(organization.OrganizationCmd)
	rootCmd.AddCommand(mcp.MCPCmd)
	rootCmd.AddCommand(cmd.DocsCmd)
	rootCmd.AddCommand(cmd.AutoCompleteCmd)
	rootCmd.AddCommand(cmd.GenerateDocsCmd)
	rootCmd.AddCommand(cmd.VersionCmd)

	// Add box subcommands as top-level shortcuts
	rootCmd.AddCommand(createBoxShortcut(box.CreateCmd))
	rootCmd.AddCommand(createBoxShortcut(box.DeleteCmd))
	rootCmd.AddCommand(createBoxShortcut(box.InfoCmd))
	rootCmd.AddCommand(createBoxShortcut(box.ListCmd))
	rootCmd.AddCommand(createBoxShortcut(box.StartCmd))
	rootCmd.AddCommand(createBoxShortcut(box.StopCmd))
	rootCmd.AddCommand(createBoxShortcut(box.SSHCmd))
	rootCmd.AddCommand(createBoxShortcut(box.ExecCmd))
	rootCmd.AddCommand(createBoxShortcut(box.PreviewUrlCmd))

	rootCmd.CompletionOptions.HiddenDefaultCmd = true
	rootCmd.PersistentFlags().BoolP("help", "", false, "help for boxlite")
	rootCmd.Flags().BoolP("version", "v", false, "Display the version of BoxLite")

	rootCmd.PreRun = func(command *cobra.Command, args []string) {
		versionFlag, _ := command.Flags().GetBool("version")
		if versionFlag {
			err := cmd.VersionCmd.RunE(command, []string{})
			if err != nil {
				log.Fatal(err)
			}
			os.Exit(0)
		}
	}
}

// createBoxShortcut creates a top-level shortcut for a box subcommand
func createBoxShortcut(original *cobra.Command) *cobra.Command {
	shortcut := &cobra.Command{
		Use:     original.Use,
		Short:   original.Short,
		Long:    original.Long,
		Args:    original.Args,
		Aliases: original.Aliases,
		GroupID: internal.BOX_GROUP,
		RunE:    original.RunE,
	}
	shortcut.Flags().AddFlagSet(original.Flags())
	return shortcut
}

func main() {
	_ = godotenv.Load()

	err := rootCmd.Execute()
	if err != nil {
		log.Fatal(err)
	}
}

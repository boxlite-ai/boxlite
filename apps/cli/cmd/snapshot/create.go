// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"context"
	"fmt"
	"strings"
	"time"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/boxlite-ai/boxlite/cli/config"
	"github.com/boxlite-ai/boxlite/cli/util"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	views_util "github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/spf13/cobra"
)

var CreateCmd = &cobra.Command{
	Use:     "create [TEMPLATE]",
	Short:   "Create a template",
	Args:    cobra.ExactArgs(1),
	Aliases: common.GetAliases("create"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		templateName := args[0]

		usingDockerfile := dockerfilePathFlag != ""
		usingImage := imageNameFlag != ""

		if !usingDockerfile && !usingImage {
			return fmt.Errorf("must specify either --dockerfile or --image")
		}

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		createTemplate := apiclient.NewCreateBoxTemplate(templateName)

		if cpuFlag != 0 {
			createTemplate.SetCpu(cpuFlag)
		}
		if memoryFlag != 0 {
			createTemplate.SetMemory(memoryFlag)
		}
		if diskFlag != 0 {
			createTemplate.SetDisk(diskFlag)
		}
		if regionIdFlag != "" {
			createTemplate.SetRegionId(regionIdFlag)
		}

		if usingDockerfile {
			createBuildInfoDto, err := common.GetCreateBuildInfoDto(ctx, dockerfilePathFlag, contextFlag)
			if err != nil {
				return err
			}
			createTemplate.SetBuildInfo(*createBuildInfoDto)
		} else if usingImage {
			err := common.ValidateImageName(imageNameFlag)
			if err != nil {
				return err
			}
			createTemplate.SetImageName(imageNameFlag)
			if entrypointFlag != "" {
				createTemplate.SetEntrypoint(strings.Split(entrypointFlag, " "))
			}
		} else if entrypointFlag != "" {
			createTemplate.SetEntrypoint(strings.Split(entrypointFlag, " "))
		}

		// Send create request
		template, res, err := apiClient.TemplatesAPI.CreateBoxTemplate(ctx).CreateBoxTemplate(*createTemplate).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		// If we're building from a Dockerfile, show build logs
		if usingDockerfile {
			c, err := config.GetConfig()
			if err != nil {
				return err
			}

			activeProfile, err := c.GetActiveProfile()
			if err != nil {
				return err
			}

			logsContext, stopLogs := context.WithCancel(context.Background())
			defer stopLogs()

			go common.ReadBuildLogs(logsContext, common.ReadLogParams{
				Id:                   template.Id,
				ServerUrl:            activeProfile.Api.Url,
				ServerApi:            activeProfile.Api,
				ActiveOrganizationId: activeProfile.ActiveOrganizationId,
				Follow:               util.Pointer(true),
				ResourceType:         common.ResourceTypeTemplate,
			})

			err = common.AwaitBoxTemplateState(ctx, apiClient, templateName, apiclient.BOXTEMPLATESTATE_PENDING)
			if err != nil {
				return err
			}

			// Wait for the last logs to be read
			time.Sleep(250 * time.Millisecond)
			stopLogs()
		}

		err = views_util.WithInlineSpinner("Waiting for the template to be validated", func() error {
			return common.AwaitBoxTemplateState(ctx, apiClient, templateName, apiclient.BOXTEMPLATESTATE_ACTIVE)
		})
		if err != nil {
			return err
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Template %s successfully created", templateName))
		view_common.RenderInfoMessage(fmt.Sprintf("%s Run 'boxlite sandbox create --template %s' to create a new sandbox using this template", view_common.Checkmark, templateName))
		return nil
	},
}

var (
	entrypointFlag     string
	imageNameFlag      string
	dockerfilePathFlag string
	contextFlag        []string
	cpuFlag            int32
	memoryFlag         int32
	diskFlag           int32
	regionIdFlag       string
)

func init() {
	CreateCmd.Flags().StringVarP(&entrypointFlag, "entrypoint", "e", "", "The entrypoint command for the template")
	CreateCmd.Flags().StringVarP(&imageNameFlag, "image", "i", "", "The image name for the template")
	CreateCmd.Flags().StringVarP(&dockerfilePathFlag, "dockerfile", "f", "", "Path to Dockerfile to build")
	CreateCmd.Flags().StringArrayVarP(&contextFlag, "context", "c", []string{}, "Files or directories to include in the build context (can be specified multiple times). If not provided, context will be automatically determined from COPY/ADD commands in the Dockerfile")
	CreateCmd.Flags().Int32Var(&cpuFlag, "cpu", 0, "CPU cores that will be allocated to the underlying sandboxes (default: 1)")
	CreateCmd.Flags().Int32Var(&memoryFlag, "memory", 0, "Memory that will be allocated to the underlying sandboxes in GB (default: 1)")
	CreateCmd.Flags().Int32Var(&diskFlag, "disk", 0, "Disk space that will be allocated to the underlying sandboxes in GB (default: 3)")
	CreateCmd.Flags().StringVar(&regionIdFlag, "region", "", "ID of the region where the template will be available (defaults to organization default region)")

	CreateCmd.MarkFlagsMutuallyExclusive("image", "dockerfile")
	CreateCmd.MarkFlagsMutuallyExclusive("image", "context")
	CreateCmd.MarkFlagsMutuallyExclusive("entrypoint", "dockerfile")
	CreateCmd.MarkFlagsMutuallyExclusive("entrypoint", "context")
}

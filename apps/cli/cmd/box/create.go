// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"context"
	"fmt"
	"strings"
	"time"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/boxlite-ai/boxlite/cli/config"
	"github.com/boxlite-ai/boxlite/cli/util"
	views_common "github.com/boxlite-ai/boxlite/cli/views/common"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

const BOX_TERMINAL_PORT = 22222

var CreateCmd = &cobra.Command{
	Use:     "create [flags]",
	Short:   "Create a new box",
	Args:    cobra.NoArgs,
	Aliases: common.GetAliases("create"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		createBox := apiclient.NewCreateBox()

		if nameFlag != "" {
			createBox.SetName(nameFlag)
		}
		if userFlag != "" {
			createBox.SetUser(userFlag)
		}
		if len(envFlag) > 0 {
			env := make(map[string]string)
			for _, e := range envFlag {
				parts := strings.SplitN(e, "=", 2)
				if len(parts) == 2 {
					env[parts[0]] = parts[1]
				}
			}
			createBox.SetEnv(env)
		}
		if len(labelsFlag) > 0 {
			labels := make(map[string]string)
			for _, l := range labelsFlag {
				parts := strings.SplitN(l, "=", 2)
				if len(parts) == 2 {
					labels[parts[0]] = parts[1]
				}
			}
			createBox.SetLabels(labels)
		}
		if publicFlag {
			createBox.SetPublic(true)
		}
		if classFlag != "" {
			createBox.SetClass(classFlag)
		}
		if targetFlag != "" {
			createBox.SetTarget(targetFlag)
		}
		if cpuFlag > 0 {
			createBox.SetCpu(cpuFlag)
		}
		if gpuFlag > 0 {
			createBox.SetGpu(gpuFlag)
		}
		if memoryFlag > 0 {
			createBox.SetMemory(memoryFlag)
		}
		if diskFlag > 0 {
			createBox.SetDisk(diskFlag)
		}
		if autoStopFlag >= 0 {
			createBox.SetAutoStopInterval(autoStopFlag)
		}
		createBox.SetAutoDeleteInterval(autoDeleteFlag)

		createBox.SetNetworkBlockAll(networkBlockAllFlag)
		if networkAllowListFlag != "" {
			createBox.SetNetworkAllowList(networkAllowListFlag)
		}

		if dockerfileFlag != "" {
			createBuildInfoDto, err := common.GetCreateBuildInfoDto(ctx, dockerfileFlag, contextFlag)
			if err != nil {
				return err
			}
			createBox.SetBuildInfo(*createBuildInfoDto)
		}

		if len(volumesFlag) > 0 {
			volumes := make([]apiclient.BoxVolume, 0, len(volumesFlag))
			for _, v := range volumesFlag {
				parts := strings.SplitN(v, ":", 2)
				if len(parts) == 2 {
					volumeId := parts[0]
					mountPath := parts[1]
					volume := apiclient.BoxVolume{
						VolumeId:  volumeId,
						MountPath: mountPath,
					}
					volumes = append(volumes, volume)
				}
			}
			if len(volumes) > 0 {
				createBox.SetVolumes(volumes)
			}
		}

		var box *apiclient.Box

		box, res, err := apiClient.BoxAPI.CreateBox(ctx).CreateBox(*createBox).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		if box.State != nil && *box.State == apiclient.BOXSTATE_PENDING_BUILD {
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
				Id:                   box.Id,
				ServerUrl:            activeProfile.Api.Url,
				ServerApi:            activeProfile.Api,
				ActiveOrganizationId: activeProfile.ActiveOrganizationId,
				Follow:               util.Pointer(true),
				ResourceType:         common.ResourceTypeBox,
			})

			err = common.AwaitBoxState(ctx, apiClient, box.Id, apiclient.BOXSTATE_STARTED)
			if err != nil {
				return err
			}

			// Wait for the last logs to be read
			time.Sleep(250 * time.Millisecond)
			stopLogs()
		}

		previewUrl, res, err := apiClient.BoxAPI.GetPortPreviewUrl(ctx, box.Id, BOX_TERMINAL_PORT).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		boldStyle := lipgloss.NewStyle().Bold(true)

		views_common.RenderInfoMessageBold(fmt.Sprintf("Box '%s' created successfully", box.Name))
		views_common.RenderInfoMessage(fmt.Sprintf("Connect via SSH:         %s", boldStyle.Render(fmt.Sprintf("boxlite ssh %s", box.Name))))
		views_common.RenderInfoMessage(fmt.Sprintf("Open the Web Terminal:   %s\n", views_common.LinkStyle.Render(previewUrl.Url)))
		return nil
	},
}

var (
	nameFlag             string
	userFlag             string
	envFlag              []string
	labelsFlag           []string
	publicFlag           bool
	classFlag            string
	targetFlag           string
	cpuFlag              int32
	gpuFlag              int32
	memoryFlag           int32
	diskFlag             int32
	autoStopFlag         int32
	autoDeleteFlag       int32
	volumesFlag          []string
	dockerfileFlag       string
	contextFlag          []string
	networkBlockAllFlag  bool
	networkAllowListFlag string
)

func init() {
	CreateCmd.Flags().StringVar(&nameFlag, "name", "", "Name of the box")
	CreateCmd.Flags().StringVar(&userFlag, "user", "", "User associated with the box")
	CreateCmd.Flags().StringArrayVarP(&envFlag, "env", "e", []string{}, "Environment variables (format: KEY=VALUE)")
	CreateCmd.Flags().StringArrayVarP(&labelsFlag, "label", "l", []string{}, "Labels (format: KEY=VALUE)")
	CreateCmd.Flags().BoolVar(&publicFlag, "public", false, "Make box publicly accessible")
	CreateCmd.Flags().StringVar(&classFlag, "class", "", "Box class type (small, medium, large)")
	CreateCmd.Flags().StringVar(&targetFlag, "target", "", "Target region (eu, us)")
	CreateCmd.Flags().Int32Var(&cpuFlag, "cpu", 0, "CPU cores allocated to the box")
	CreateCmd.Flags().Int32Var(&gpuFlag, "gpu", 0, "GPU units allocated to the box")
	CreateCmd.Flags().Int32Var(&memoryFlag, "memory", 0, "Memory allocated to the box in MB")
	CreateCmd.Flags().Int32Var(&diskFlag, "disk", 0, "Disk space allocated to the box in GB")
	CreateCmd.Flags().Int32Var(&autoStopFlag, "auto-stop", 15, "Auto-stop interval in minutes (0 means disabled)")
	CreateCmd.Flags().Int32Var(&autoDeleteFlag, "auto-delete", -1, "Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping)")
	CreateCmd.Flags().StringArrayVarP(&volumesFlag, "volume", "v", []string{}, "Volumes to mount (format: VOLUME_NAME:MOUNT_PATH)")
	CreateCmd.Flags().StringVarP(&dockerfileFlag, "dockerfile", "f", "", "Path to Dockerfile for box build")
	CreateCmd.Flags().StringArrayVarP(&contextFlag, "context", "c", []string{}, "Files or directories to include in the build context (can be specified multiple times)")
	CreateCmd.Flags().BoolVar(&networkBlockAllFlag, "network-block-all", false, "Whether to block all network access for the box")
	CreateCmd.Flags().StringVar(&networkAllowListFlag, "network-allow-list", "", "Comma-separated list of allowed CIDR network addresses for the box")
}

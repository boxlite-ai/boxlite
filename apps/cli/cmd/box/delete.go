// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	views_util "github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/spf13/cobra"
)

const spinnerThreshold = 10

var DeleteCmd = &cobra.Command{
	Use:     "delete [BOX_ID] | [BOX_NAME]",
	Short:   "Delete a box",
	Args:    cobra.MaximumNArgs(1),
	Aliases: common.GetAliases("delete"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		// Handle case when no box ID is provided and allFlag is true
		if len(args) == 0 {
			if allFlag {
				page := float32(1.0)
				limit := float32(200.0) // 200 is the maximum limit for the API
				var allBoxes []apiclient.Box

				for {
					boxBatch, res, err := apiClient.BoxAPI.ListBoxesPaginated(ctx).Page(page).Limit(limit).Execute()
					if err != nil {
						return apiclient_cli.HandleErrorResponse(res, err)
					}

					allBoxes = append(allBoxes, boxBatch.Items...)

					if len(boxBatch.Items) < int(limit) || page >= float32(boxBatch.TotalPages) {
						break
					}
					page++
				}

				if len(allBoxes) == 0 {
					view_common.RenderInfoMessageBold("No boxes to delete")
					return nil
				}

				var deletedCount int64

				deleteFn := func() error {
					var wg sync.WaitGroup
					sem := make(chan struct{}, 10) // limit to 10 concurrent deletes

					for _, sb := range allBoxes {
						wg.Add(1)
						go func(sb apiclient.Box) {
							defer wg.Done()
							sem <- struct{}{}
							defer func() { <-sem }()

							_, _, err := apiClient.BoxAPI.DeleteBox(ctx, sb.Id).Execute()
							if err != nil {
								fmt.Printf("Failed to delete box %s\n", sb.Id)
							} else {
								atomic.AddInt64(&deletedCount, 1)
							}
						}(sb)
					}
					wg.Wait()
					return nil
				}

				if len(allBoxes) > spinnerThreshold {
					err = views_util.WithInlineSpinner("Deleting all boxes", deleteFn)
				} else {
					err = deleteFn()
				}
				if err != nil {
					return err
				}

				view_common.RenderInfoMessageBold(fmt.Sprintf("Deleted %d boxes", atomic.LoadInt64(&deletedCount)))
				return nil
			}
			return cmd.Help()
		}

		// Handle case when a box ID is provided
		boxIdOrNameArg := args[0]

		_, res, err := apiClient.BoxAPI.DeleteBox(ctx, boxIdOrNameArg).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Box %s deleted", boxIdOrNameArg))

		return nil
	},
}

var allFlag bool

func init() {
	DeleteCmd.Flags().BoolVarP(&allFlag, "all", "a", false, "Delete all boxes")
}

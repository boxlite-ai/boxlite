// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"fmt"
	"sort"

	"github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

type RowData struct {
	Name      string
	State     string
	Region    string
	Class     string
	LastEvent string
}

func ListBoxes(boxList []apiclient.Box, activeOrganizationName *string) {
	if len(boxList) == 0 {
		util.NotifyEmptyBoxList(true)
		return
	}

	headers := []string{"Box", "State", "Region", "Class", "Last Event"}

	data := [][]string{}

	for _, s := range boxList {
		var rowData *RowData
		var row []string

		rowData = getTableRowData(s)
		row = getRowFromRowData(*rowData)
		data = append(data, row)
	}

	table := util.GetTableView(data, headers, activeOrganizationName, func() {
		renderUnstyledList(boxList)
	})

	fmt.Println(table)
}

func SortBoxes(boxList *[]apiclient.Box) {
	sort.Slice(*boxList, func(i, j int) bool {
		pi, pj := getStateSortPriorities(*(*boxList)[i].State, *(*boxList)[j].State)
		if pi != pj {
			return pi < pj
		}

		if (*boxList)[i].CreatedAt == nil || (*boxList)[j].CreatedAt == nil {
			return true
		}

		// If two boxes have the same state priority, compare the UpdatedAt property
		return *(*boxList)[i].CreatedAt > *(*boxList)[j].CreatedAt
	})
}

func getTableRowData(box apiclient.Box) *RowData {
	rowData := RowData{"", "", "", "", ""}
	rowData.Name = box.Id + util.AdditionalPropertyPadding
	if box.State != nil {
		rowData.State = getStateLabel(*box.State)
	}

	rowData.Region = box.Target
	if box.Class != nil {
		rowData.Class = *box.Class
	}

	if box.UpdatedAt != nil {
		rowData.LastEvent = util.GetTimeSinceLabelFromString(*box.UpdatedAt)
	}

	return &rowData
}

func renderUnstyledList(boxList []apiclient.Box) {
	for _, box := range boxList {
		RenderInfo(&box, true)

		if box.Id != boxList[len(boxList)-1].Id {
			fmt.Printf("\n%s\n\n", common.SeparatorString)
		}

	}
}

func getRowFromRowData(rowData RowData) []string {
	row := []string{
		common.NameStyle.Render(rowData.Name),
		rowData.State,
		common.DefaultRowDataStyle.Render(rowData.Region),
		common.DefaultRowDataStyle.Render(rowData.Class),
		common.DefaultRowDataStyle.Render(rowData.LastEvent),
	}

	return row
}

func getStateSortPriorities(state1, state2 apiclient.BoxState) (int, int) {
	pi, ok := boxListStatePriorities[state1]
	if !ok {
		pi = 99
	}
	pj, ok2 := boxListStatePriorities[state2]
	if !ok2 {
		pj = 99
	}

	return pi, pj
}

// Boxes that have actions being performed on them have a higher priority when listing
var boxListStatePriorities = map[apiclient.BoxState]int{
	"pending":       1,
	"pending-start": 1,
	"deleting":      1,
	"creating":      1,
	"started":       2,
	"undefined":     2,
	"error":         3,
	"build-failed":  3,
	"stopped":       4,
}

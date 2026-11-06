// Bridge accessor declarations for the Go-exported callback symbols.
// Implementation lives in bridge.c; consumers include this header in their
// cgo preamble to call C.cbXxx() from Go.

#ifndef BOXLITE_GO_BRIDGE_H
#define BOXLITE_GO_BRIDGE_H

#include "boxlite.h"

// Private Runner ABI, deliberately excluded from the public SDK header.
extern enum BoxliteErrorCode boxlite_internal_runtime_new_runner(
    const char *, const struct BoxliteImageRegistry *, int, const char *,
    CBoxliteRuntime **, CBoxliteError *);
extern enum BoxliteErrorCode boxlite_internal_advanced_options_set_nested_virtualization(
    CAdvancedBoxOptions *, int);
extern enum BoxliteErrorCode boxlite_internal_runner_start_box(
    CBoxHandle *, int, CBoxStartBoxCb, void *, CBoxliteError *);

extern CBoxStdoutCb cbStdout(void);
extern CBoxStderrCb cbStderr(void);
extern CBoxExitCb cbExit(void);

extern CBoxCreateBoxCb cbCreateBox(void);
extern CBoxExportCb cbBoxExport(void);
extern CRuntimeImportCb cbRuntimeImport(void);
extern CCheckpointArchiveCb cbCheckpointArchive(void);
extern CCheckpointInfoCb cbCheckpointInfo(void);
extern CCheckpointListCb cbCheckpointList(void);
extern CBoxGetOrCreateBoxCb cbGetOrCreateBox(void);
extern CBoxGetBoxCb cbGetBox(void);
extern CBoxStartBoxCb cbStartBox(void);
extern CBoxStopBoxCb cbStopBox(void);
extern CBoxRemoveBoxCb cbRemoveBox(void);
extern CBoxCopyCb cbCopy(void);

extern CBoxImagePullCb cbImagePull(void);
extern CBoxImageListCb cbImageList(void);
extern CBoxImageGetCb cbImageGet(void);
extern CBoxImageRemoveCb cbImageRemove(void);
extern CBoxImageUsageCb cbImageUsage(void);

extern CBoxVolumeCreateCb cbVolumeCreate(void);
extern CBoxVolumeListCb cbVolumeList(void);
extern CBoxVolumeGetCb cbVolumeGet(void);
extern CBoxVolumeRemoveCb cbVolumeRemove(void);

extern CBoxRegistryCreateCb cbRegistryCreate(void);
extern CBoxRegistryListCb cbRegistryList(void);
extern CBoxRegistryRemoveCb cbRegistryRemove(void);

extern CBoxInfoCb cbInfo(void);
extern CBoxInfoListCb cbInfoList(void);
extern CExecutionInfoListCb cbExecutionInfoList(void);

extern CBoxMetricsCb cbBoxMetrics(void);
extern CRuntimeMetricsCb cbRuntimeMetrics(void);

extern CRuntimeShutdownCb cbRuntimeShutdown(void);

extern CExecutionWaitCb cbExecutionWait(void);
extern CExecutionKillCb cbExecutionKill(void);
extern CExecutionSignalCb cbExecutionSignal(void);
extern CExecutionResizeCb cbExecutionResize(void);
extern CTunnelForwarderWaitCb cbTunnelForwarderWait(void);
extern CTunnelForwarderCloseCb cbTunnelForwarderClose(void);

extern CBoxSshConfigureCb cbSSHConfigure(void);
extern CBoxSshStatusCb cbSSHStatus(void);
extern CBoxSshDisableCb cbSSHDisable(void);
extern CBoxSshEnableCb cbSSHEnable(void);

#endif // BOXLITE_GO_BRIDGE_H

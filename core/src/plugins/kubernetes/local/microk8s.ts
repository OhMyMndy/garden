/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import tmp from "tmp-promise"
import { RuntimeError } from "../../../exceptions"
import { LogEntry } from "../../../logger/log-entry"
import { exec } from "../../../util/util"
import { containerHelpers } from "../../container/helpers"
import { ContainerModule } from "../../container/config"
import { BuildStatus } from "../../../types/plugin/module/getBuildStatus"
import chalk from "chalk"
import { naturalList, deline } from "../../../util/string"
import { ExecaReturnValue } from "execa"
import { PluginContext } from "../../../plugin-context"
import { parse as parsePath } from "path"

export async function configureMicrok8sAddons(log: LogEntry, addons: string[]) {
  let statusCommandResult: ExecaReturnValue | undefined = undefined
  let status = ""

  try {
    statusCommandResult = await exec("microk8s", ["status"])
    status = statusCommandResult.stdout
  } catch (err) {
    if (err.all?.includes("permission denied") || err.all?.includes("Insufficient permissions")) {
      log.warn(
        chalk.yellow(
          deline`Unable to get microk8s status and manage addons. You may need to add the current user to the microk8s
          group. Alternatively, you can manually ensure that the ${naturalList(addons)} are enabled.`
        )
      )
      return
    } else {
      statusCommandResult = err
    }
  }

  if (!status.includes("microk8s is running")) {
    throw new RuntimeError(`Unable to get microk8s status. Is the cluster installed and running?`, {
      status,
      statusCommandResult,
    })
  }

  const missingAddons = addons.filter((addon) => !status.includes(`${addon}: enabled`))

  if (missingAddons.length > 0) {
    log.info({ section: "microk8s", msg: `enabling required addons (${missingAddons.join(", ")})` })
    await exec("microk8s", ["enable"].concat(missingAddons))
  }
}

export async function getMicrok8sImageStatus(imageId: string): Promise<BuildStatus> {
  const parsedId = containerHelpers.parseImageId(imageId)
  const clusterId = containerHelpers.unparseImageId({
    ...parsedId,
    host: parsedId.host || "docker.io",
    namespace: parsedId.namespace || "library",
  })

  const res = await exec("microk8s", ["ctr", "images", "ls", "-q"])
  return { ready: res.stdout.split("\n").includes(clusterId) }
}

const MULTIPASS_VM_NAME = "microk8s-vm"

type MultipassListOutput = {
  list: {
    ipv4: string[]
    name: string
    release: string
    state: string
  }[]
}

async function isMicrok8sRunningInMultipassVM(): Promise<boolean> {
  try {
    const res = await exec("multipass", ["list", "--format", "json"])

    const data = JSON.parse(res.stdout) as MultipassListOutput
    return data.list.some((vm) => vm.name === MULTIPASS_VM_NAME)
  } catch (_err) {
    return false
  }
}

export async function loadImageToMicrok8s({
  module,
  imageId,
  log,
  ctx,
}: {
  module: ContainerModule
  imageId: string
  log: LogEntry
  ctx: PluginContext
}): Promise<void> {
  try {
    // See https://microk8s.io/docs/registry-images for reference
    await tmp.withFile(async (file) => {
      await containerHelpers.dockerCli({
        cwd: module.buildPath,
        args: ["save", "-o", file.path, imageId],
        log,
        ctx,
      })

      const isInMultipassVM = await isMicrok8sRunningInMultipassVM()

      const parsedTempFilePath = parsePath(file.path)
      const sourceFilePath = file.path

      // If running in multipass, we first need to transfer the file into the VM
      // And then later on remove it again manually

      // We only grab the base name of the temp file
      // since else we would need to create the entire path of the temp file first
      // Once microk8s releases with multipass v1.11.0,
      // we can use the `-p` flag and simplify this code again
      const filePath = isInMultipassVM ? `/tmp/${parsedTempFilePath.base}` : sourceFilePath

      // Transfer the file from the source path into the new destination path within the VM
      if (isInMultipassVM) {
        await exec("multipass", ["transfer", sourceFilePath, `${MULTIPASS_VM_NAME}:${filePath}`])
      }

      await exec("microk8s", ["ctr", "image", "import", filePath])

      // Clean up the file within the VM by deleting it explicitly
      if (isInMultipassVM) {
        await exec("multipass", ["exec", MULTIPASS_VM_NAME, "rm", filePath])
      }
    })
  } catch (err) {
    throw new RuntimeError(`An attempt to load image ${imageId} into the microk8s cluster failed: ${err.message}`, {
      err,
    })
  }
}

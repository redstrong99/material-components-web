/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const VError = require('verror');

const BuildCommand = require('./build');
const Cli = require('../lib/cli');
const CliColor = require('../lib/logger').colors;
const Controller = require('../lib/controller');
const GitHubApi = require('../lib/github-api');
const ImageDiffer = require('../lib/image-differ');
const Logger = require('../lib/logger');
const {ExitCode} = require('../lib/constants');

const cli = new Cli();
const gitHubApi = new GitHubApi();
const imageDiffer = new ImageDiffer();
const logger = new Logger(__filename);

module.exports = {
  async runAsync() {
    await BuildCommand.runAsync();

    const cliDiffBase = cli.diffBase;

    /** @type {!mdc.proto.ReportData} */
    const localDiffReportData = await this.diffEmAll_(cliDiffBase);

    const {isTestable, prNumber} = this.checkIsTestable_(localDiffReportData);
    if (!isTestable) {
      const underline = CliColor.underline;
      const boldGreen = CliColor.bold.green;
      logger.warn(`
${underline(`PR #${prNumber}`)} does not contain any testable source file changes.

${boldGreen('Skipping screenshot tests.')}
`);
      return ExitCode.OK;
    }

    await gitHubApi.setPullRequestStatusAuto(localDiffReportData);

    const localDiffExitCode = this.getExitCode_(localDiffReportData);
    if (localDiffExitCode !== ExitCode.OK) {
      return localDiffExitCode;
    }

    // TODO(acdvorak): Find a better way
    if (cliDiffBase.startsWith('origin/master')) {
      return ExitCode.OK;
    }

    const screenshots = localDiffReportData.screenshots;
    /** @type {!Array<!mdc.proto.Screenshot>} */
    const capturedScreenshots = [].concat(
      screenshots.changed_screenshot_list,
      screenshots.added_screenshot_list,
      screenshots.removed_screenshot_list,
      screenshots.unchanged_screenshot_list,
    );

    await this.diffEmAll_('origin/master', capturedScreenshots);

    return ExitCode.OK;
  },

  /**
   * TODO(acdvorak): Pass diffbase through the stack instead of using `Cli#diffBase`
   * @param {string} cliDiffBase
   * @param {!Array<!mdc.proto.Screenshot>} capturedScreenshots
   * @return {!Promise<!mdc.proto.ReportData>}
   * @private
   */
  async diffEmAll_(cliDiffBase, capturedScreenshots = []) {
    const controller = new Controller();

    /** @type {!mdc.proto.ReportData} */
    const reportData = await controller.initForCapture(cliDiffBase);

    try {
      if (capturedScreenshots.length === 0) {
        await gitHubApi.setPullRequestStatusAuto(reportData);
      }

      await controller.uploadAllAssets(reportData);

      if (capturedScreenshots.length === 0) {
        await controller.captureAllPages(reportData);
        await gitHubApi.setPullRequestStatusAuto(reportData);
      } else {
        await this.copyAndCompareScreenshots_({reportData, capturedScreenshots});
      }

      controller.populateMaps(reportData);

      await controller.uploadAllImages(reportData);
      await controller.generateReportPage(reportData);

      if (capturedScreenshots.length === 0) {
        await gitHubApi.setPullRequestStatusAuto(reportData);
      }
    } catch (err) {
      await gitHubApi.setPullRequestError();
      throw new VError(err, 'Failed to run screenshot tests');
    }

    return reportData;
  },

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {{isTestable: boolean, prNumber: ?number}}
   */
  checkIsTestable_(reportData) {
    const goldenGitRevision = reportData.meta.golden_diff_base.git_revision;
    const shouldSkipScreenshotTests =
      goldenGitRevision &&
      goldenGitRevision.type === GitRevision.Type.TRAVIS_PR &&
      goldenGitRevision.pr_file_paths.length === 0;

    return {
      isTestable: !shouldSkipScreenshotTests,
      prNumber: goldenGitRevision ? goldenGitRevision.pr_number : null,
    };
  },

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @param {!Array<!mdc.proto.Screenshot>} capturedScreenshots
   * @return {!Promise<void>}
   * @private
   */
  async copyAndCompareScreenshots_({reportData, capturedScreenshots}) {
    const promises = [];
    const screenshots = reportData.screenshots;
    const masterScreenshots = screenshots.actual_screenshot_list;
    for (const masterScreenshot of masterScreenshots) {
      for (const capturedScreenshot of capturedScreenshots) {
        if (capturedScreenshot.html_file_path !== masterScreenshot.html_file_path ||
            capturedScreenshot.user_agent.alias !== masterScreenshot.user_agent.alias) {
          continue;
        }
        promises.push(new Promise(async (resolve) => {
          console.log(`Comparing ${masterScreenshot.html_file_path} > ${masterScreenshot.user_agent.alias}...`);
          masterScreenshot.actual_html_file = capturedScreenshot.actual_html_file;
          masterScreenshot.actual_image_file = capturedScreenshot.actual_image_file;
          masterScreenshot.capture_state = capturedScreenshot.capture_state;

          /** @type {!mdc.proto.DiffImageResult} */
          const diffImageResult = await imageDiffer.compareOneScreenshot({
            meta: reportData.meta,
            screenshot: masterScreenshot,
          });

          masterScreenshot.diff_image_result = diffImageResult;
          masterScreenshot.diff_image_file = diffImageResult.diff_image_file;

          if (diffImageResult.has_changed) {
            reportData.screenshots.changed_screenshot_list.push(masterScreenshot);
          } else {
            reportData.screenshots.unchanged_screenshot_list.push(masterScreenshot);
          }
          reportData.screenshots.comparable_screenshot_list.push(masterScreenshot);

          console.log(`Compared ${masterScreenshot.html_file_path} > ${masterScreenshot.user_agent.alias}!`);

          resolve();
        }));
      }
    }
    await Promise.all(promises);
    console.log('Done copying and comparing screenshots!');
  },

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!ExitCode|number}
   */
  getExitCode_(reportData) {
    // TODO(acdvorak): Store this directly in the proto so we don't have to recalculate it all over the place
    const numChanges =
      reportData.screenshots.changed_screenshot_list.length +
      reportData.screenshots.added_screenshot_list.length +
      reportData.screenshots.removed_screenshot_list.length;

    const isOnline = cli.isOnline();
    if (isOnline && numChanges > 0) {
      return ExitCode.CHANGES_FOUND;
    }
    return ExitCode.OK;
  },
};
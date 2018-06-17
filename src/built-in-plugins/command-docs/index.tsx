import * as chokidar from 'chokidar';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as portfinder from 'portfinder';
import * as prettier from 'prettier';
import * as urlJoin from 'url-join';
import * as webpack from 'webpack';
import { pri } from '../../node';
import { analyseProject } from '../../utils/analyse-project';
import { spinner } from '../../utils/log';
import { prettierConfig } from '../../utils/prettier-config';
import { docsPath, tempPath } from '../../utils/structor-config';
import text from '../../utils/text';
import { runWebpackDevServer } from '../../utils/webpack-dev-server';
import { WrapContent } from '../../utils/webpack-plugin-wrap-content';
import { bundleDlls, dllMainfestName, dllOutPath, libraryStaticPath } from '../command-dev/dll';

interface IResult {
  projectAnalyseDocs: {
    docs: Array<{
      file: path.ParsedPath;
    }>;
  };
}

export default async (instance: typeof pri) => {
  const docsEntryPath = path.join(instance.projectRootPath, tempPath.dir, 'docs-entry.tsx');

  if (instance.majorCommand === 'docs') {
    instance.build.pipeConfig(config => {
      if (!instance.isDevelopment) {
        return config;
      }

      config.plugins.push(
        new webpack.DllReferencePlugin({
          context: '.',
          manifest: require(path.join(dllOutPath, dllMainfestName))
        })
      );

      return config;
    });
  }

  instance.project.onAnalyseProject(files => {
    const result = {
      projectAnalyseDocs: {
        docs: files
          .filter(file => {
            const relativePath = path.relative(instance.projectRootPath, path.join(file.dir, file.name));

            if (!relativePath.startsWith(docsPath.dir)) {
              return false;
            }

            if (file.isDir) {
              return false;
            }

            if (['.tsx'].indexOf(file.ext) === -1) {
              return false;
            }

            return true;
          })
          .map(file => {
            return { file };
          })
      }
    } as IResult;

    // Create entry file for docs
    const docList: string[] = [];

    const docsEntryContent = prettier.format(
      `
      import * as React from "react"
      import * as ReactDOM from 'react-dom'
      import { hot } from 'react-hot-loader'
      
      const DocsWrapper = require("${path.join(__dirname, 'docs-wrapper')}").default

      ${(() => {
        const docFiles = result.projectAnalyseDocs.docs;
        return docFiles
          .map((docFile, index) => {
            const docFilePathWithoutPrefix = path.join(docFile.file.dir, docFile.file.name);
            const docImportPath = path.relative(path.parse(docsEntryPath).dir, docFilePathWithoutPrefix);
            const fileName = `Doc${index}`;
            docList.push(`
            {
              name: "${docFile.file.name}",
              element: ${fileName}
            }
          `);
            return `
            import * as ${fileName} from '${docImportPath}'
          `;
          })
          .join('\n');
      })()}

      const DocComponents = [${docList.join(',')}]

      class Docs extends React.PureComponent {
        public render() {
          return (
            <DocsWrapper docs={DocComponents}/>
          )
        }
      }

      const ROOT_ID = 'root';

      const HotDocs = hot(module)(Docs);

      // Create entry div if not exist.
      if (!document.getElementById(ROOT_ID)) {
        const rootDiv = document.createElement('div');
        rootDiv.id = ROOT_ID;
        document.body.appendChild(rootDiv);
      }

      ReactDOM.render(<HotDocs />, document.getElementById(ROOT_ID));
    `,
      {
        ...prettierConfig,
        parser: 'typescript'
      }
    );

    fs.writeFileSync(docsEntryPath, docsEntryContent);

    return result;
  });

  instance.commands.registerCommand({
    name: 'docs',
    description: text.commander.docs.description,
    action: async () => {
      await instance.project.lint();
      await instance.project.ensureProjectFiles();
      await instance.project.checkProjectFiles();

      // Anaylse project for init.
      await spinner('Analyse project', async () => {
        return analyseProject();
      });

      await bundleDlls();

      chokidar
        .watch(path.join(instance.projectRootPath, docsPath.dir, '/**'), {
          ignored: /(^|[\/\\])\../,
          ignoreInitial: true
        })
        .on('add', async filePath => {
          await analyseProject();
        })
        .on('unlink', async filePath => {
          await analyseProject();
        })
        .on('unlinkDir', async filePath => {
          await analyseProject();
        });

      // Serve docs
      const freePort = await portfinder.getPortPromise();
      await runWebpackDevServer({
        publicPath: '/',
        entryPath: docsEntryPath,
        devServerPort: freePort,
        htmlTemplatePath: path.join(__dirname, '../../../template-project.ejs'),
        pipeConfig: config => {
          const dllHttpPath = urlJoin(
            `${instance.projectConfig.useHttps ? 'https' : 'http'}://127.0.0.1:${freePort}`,
            libraryStaticPath
          );

          config.plugins.push(
            new WrapContent(
              `
          var dllScript = document.createElement("script");
          dllScript.src = "${dllHttpPath}";
          dllScript.onload = runEntry;
          document.body.appendChild(dllScript);

          function runEntry() {
        `,
              `}`
            )
          );
          return config;
        }
      });
    }
  });
};
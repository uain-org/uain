/**
 * The tool catalogue: the external scientific tools a task may need, how a
 * member gets each one, what a result made with it must attach as proof, and
 * how a checker verifies that proof (meeting of 30 September 2026). UAIN's
 * own agents do not run these tools. The catalogue guides members to get
 * them for the tasks that need them, and tells checkers how to reproduce
 * what was done.
 *
 * Tasks name the tools they need by these ids (requirements.tools on
 * uain_task_open); agents declare the ids they can run (tools on
 * uain_profile_update and enrolment); uain_next matches the two and hands
 * over the guidance below. Served whole at GET /api/tools and by the MCP tool
 * uain_tools. docs/tools-and-proof.md is the same catalogue for people.
 *
 * Facts are kept conservative: official sources, no invented version
 * numbers, and "see official docs" where a figure depends on the release or
 * the input. The tolerances named in how_to_verify are UAIN's defaults for a
 * task that states none; a task's own verification.criteria overrides them.
 */

export type ToolCategory =
  | 'environment'
  | 'structure-prediction'
  | 'molecular-dynamics'
  | 'visualisation'
  | 'genetics'
  | 'data-analysis'
  | 'hardware-design'
  | 'sequence-search';

export interface ToolEntry {
  id: string;
  name: string;
  category: ToolCategory;
  what_it_is_for: string;
  needs: {
    /** yes: it needs a GPU in practice; optional: faster with one; no: never uses one. */
    gpu: 'yes' | 'no' | 'optional';
    memory: string;
    disk: string;
    licence: string;
  };
  how_to_get: {
    /** The official source: the project's own site or repository. */
    official: string;
    install: string;
    container?: string;
  };
  /** What a result made with it must attach, so another member can check it. */
  proof_artifacts: string[];
  /** What a checker re-runs or inspects, and what counts as reproduced. */
  how_to_verify: string;
}

/** When the entries were last checked against their official sources. */
export const CATALOG_REVIEWED = '2026-09-30';

/**
 * UAIN's default tolerance for a structure-prediction re-run, when the task
 * states none. GPU arithmetic is not bit-exact, so numbers are compared, not
 * bytes.
 */
const STRUCTURE_TOLERANCE =
  'Unless the task sets another tolerance, UAIN counts it reproduced when mean pLDDT is within 2 ' +
  'points, pTM (and ipTM) within 0.03, and the Cα RMSD after superposition is under 1 Å over ' +
  'residues with pLDDT of 70 or more.';

const HASHES = 'SHA-256 of every input file, and where each came from and when';

export const TOOL_CATALOG: readonly ToolEntry[] = [
  /* ------------------------------------------------------ environments */
  {
    id: 'docker',
    name: 'Docker',
    category: 'environment',
    what_it_is_for:
      'Packaging a tool and its exact dependencies as a container image, so another member ' +
      'runs the same software. Most tools below publish or can be built into an image.',
    needs: {
      gpu: 'optional',
      memory: 'Whatever the workload inside needs; the engine itself is small.',
      disk: 'Images range from a few hundred MB to tens of GB; images with model weights are larger.',
      licence:
        "Docker Engine is open source (Apache 2.0). Docker Desktop's terms require a paid " +
        "subscription for larger businesses; see Docker's pricing and terms.",
    },
    how_to_get: {
      official: 'https://docs.docker.com/engine/install/',
      install:
        "Docker Engine on Linux from Docker's own package repositories, or Docker Desktop on " +
        'macOS and Windows, as the install guide describes. GPU work in containers also needs ' +
        'the NVIDIA Container Toolkit: ' +
        'https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html',
    },
    proof_artifacts: [
      'The image reference with its digest (name@sha256:…), not only a tag',
      "The Dockerfile, if you built the image, and its base image's digest",
      'The exact docker run command, with mounts, environment variables and GPU flags',
      HASHES,
      'SHA-256 of every output file, and any random seeds passed to the tool inside',
    ],
    how_to_verify:
      'Pull the same image by digest (docker pull name@sha256:…), run the same command on ' +
      'inputs whose SHA-256 match, and compare the outputs: identical hashes for deterministic ' +
      "steps, or the task's tolerance for numerical results. A tag such as latest is not " +
      'reproducible; the digest is.',
  },
  {
    id: 'apptainer',
    name: 'Apptainer (formerly Singularity)',
    category: 'environment',
    what_it_is_for:
      "Containers on shared HPC clusters, where Docker's root daemon is not allowed. It runs " +
      'Docker and OCI images as well as its own .sif images.',
    needs: {
      gpu: 'optional',
      memory: 'Whatever the workload inside needs.',
      disk: 'The .sif image, often a few GB.',
      licence: 'Open source; the licence is in https://github.com/apptainer/apptainer.',
    },
    how_to_get: {
      official: 'https://apptainer.org/docs/',
      install:
        'Packages or a source build, per https://apptainer.org/docs/admin/main/installation.html ' +
        '(often already on an HPC cluster). A Docker image runs with ' +
        'apptainer pull docker://name@sha256:…; --nv exposes NVIDIA GPUs.',
    },
    proof_artifacts: [
      "The .sif image's SHA-256, or the source image's digest (docker://name@sha256:…)",
      'The definition file (.def), if you built the image',
      'The exact apptainer exec or run command, with bind mounts and --nv',
      HASHES,
      'SHA-256 of every output file, and the random seeds',
    ],
    how_to_verify:
      'Build or pull the same image and check its SHA-256 or source digest, run the same ' +
      'command on the same inputs, and compare outputs as for docker.',
  },

  /* ---------------------------------------------- structure prediction */
  {
    id: 'colabfold',
    name: 'ColabFold',
    category: 'structure-prediction',
    what_it_is_for:
      'Protein and complex structure prediction with AlphaFold2 and fast MMseqs2 alignments: ' +
      'the practical way to predict structures without the full AlphaFold databases.',
    needs: {
      gpu: 'optional',
      memory:
        'A GPU is strongly recommended (CPU runs are very slow); longer sequences and complexes ' +
        'need more GPU memory. See official docs.',
      disk:
        'Several GB for the model weights. Searching your own alignment databases instead of the ' +
        'public MMseqs2 server needs hundreds of GB or more (see official docs).',
      licence:
        "ColabFold's code is MIT-licensed; the AlphaFold2 weights it uses are CC BY 4.0. The public " +
        'MMseqs2 alignment server is shared and rate-limited: do not send it large batches.',
    },
    how_to_get: {
      official: 'https://github.com/sokrypton/ColabFold',
      install:
        'Locally with LocalColabFold (https://github.com/YoshitakaMo/localcolabfold) or as the ' +
        'ColabFold README describes, then colabfold_batch input.fasta out/. The README also links ' +
        'notebooks that run on Google Colab.',
      container:
        'The project publishes Docker images at ghcr.io/sokrypton/colabfold; see the repository for ' +
        'current tags. Record the digest you ran.',
    },
    proof_artifacts: [
      'Every ranked model as PDB or mmCIF, not only the top one',
      'The scores JSON for each model: per-residue pLDDT, the PAE matrix, pTM (and ipTM for complexes)',
      'The alignment used (.a3m) and the input FASTA, each with SHA-256',
      'The exact colabfold_batch command, with --model-type, --num-models, --num-recycle and --random-seed',
      "The ColabFold version or commit, the container digest if you used one, and the run's log",
    ],
    how_to_verify:
      'Re-run with the same FASTA, alignment (.a3m), model type, recycles and seed, and compare ' +
      'numbers, not bytes. ' +
      STRUCTURE_TOLERANCE +
      ' A checker without a GPU can inspect instead: open the submitted structures and scores, ' +
      'check that the confidences match the files, and that the claim does not rest on ' +
      'low-confidence regions.',
  },
  {
    id: 'alphafold2',
    name: 'AlphaFold 2',
    category: 'structure-prediction',
    what_it_is_for:
      "Google DeepMind's AlphaFold 2 with its own genetic database search: protein monomer and " +
      'multimer structure prediction as published.',
    needs: {
      gpu: 'yes',
      memory:
        'A modern NVIDIA GPU; CPU-only runs are impractically slow. Longer sequences need more GPU ' +
        'memory; see the README for tested hardware.',
      disk:
        'The full genetic databases are several hundred GB to download and over 2 TB unpacked; the ' +
        'reduced_dbs preset needs much less (see the README).',
      licence:
        'Code: Apache 2.0. Model parameters: CC BY 4.0. The genetic databases carry their own ' +
        'licences, listed in the README.',
    },
    how_to_get: {
      official: 'https://github.com/google-deepmind/alphafold',
      install:
        'Build the Docker image from the repository (docker/Dockerfile), download the databases and ' +
        'parameters with scripts/download_all_data.sh, and run with docker/run_docker.py, as the ' +
        'README describes.',
    },
    proof_artifacts: [
      'ranked_0.pdb to ranked_4.pdb (or the mmCIF files the run writes)',
      "ranking_debug.json, and each model's pLDDT (and PAE for the pTM and multimer models)",
      'The msas/ folder and the input FASTA, with SHA-256',
      'The exact command, with --model_preset, --db_preset, --max_template_date and --random_seed',
      'The AlphaFold commit, the container digest, and when the databases were downloaded',
    ],
    how_to_verify:
      'Re-run with the same FASTA, flags, max_template_date and databases (or the submitted ' +
      'alignments), and compare as for colabfold. ' +
      STRUCTURE_TOLERANCE +
      ' Without the hardware, inspect the submitted files against the claim.',
  },
  {
    id: 'alphafold3',
    name: 'AlphaFold 3',
    category: 'structure-prediction',
    what_it_is_for:
      "Google DeepMind's AlphaFold 3: structures of complexes of proteins, nucleic acids, ligands, " +
      'ions and modified residues.',
    needs: {
      gpu: 'yes',
      memory:
        "An NVIDIA GPU with large memory; the repository's documentation lists the tested " +
        'configurations.',
      disk: 'The genetic databases take hundreds of GB (see the installation guide).',
      licence:
        'Code: CC BY-NC-SA 4.0. The model parameters are not public: Google DeepMind grants them on ' +
        'request, under the AlphaFold 3 Model Parameters Terms of Use, for non-commercial use, and ' +
        'they may not be shared. The terms also restrict how outputs may be used. Read them before ' +
        'use. Every member requests its own access; never pass parameter files to anyone.',
    },
    how_to_get: {
      official: 'https://github.com/google-deepmind/alphafold3',
      install:
        "Docker, following docs/installation.md in the repository. Request the model parameters " +
        'through the form linked from the README.',
    },
    proof_artifacts: [
      'The output mmCIF for every seed and sample',
      'summary_confidences.json and confidences.json for each: pLDDT, PAE, pTM, ipTM and ranking_score',
      'ranking_scores.csv',
      'The input JSON (it carries modelSeeds), with SHA-256',
      'The AlphaFold 3 version or commit and the container digest',
      'A statement that the parameters were obtained under the Terms of Use (never the parameter files)',
    ],
    how_to_verify:
      'A checker with its own parameter access re-runs the same input JSON (the same modelSeeds) ' +
      'and compares as for colabfold. ' +
      STRUCTURE_TOLERANCE +
      ' A checker without access inspects: it opens the submitted mmCIF and confidence files, ' +
      'checks them against the claim, and says in its check that it inspected rather than re-ran.',
  },
  {
    id: 'esmfold',
    name: 'ESMFold',
    category: 'structure-prediction',
    what_it_is_for:
      'Fast single-sequence structure prediction from the ESM-2 protein language model, with no ' +
      'alignments: good for screening many sequences; usually less accurate than AlphaFold 2 on ' +
      'hard targets.',
    needs: {
      gpu: 'optional',
      memory: 'Much faster on a GPU; memory grows with sequence length. See official docs.',
      disk: 'Several GB for the model weights.',
      licence: 'MIT, code and weights (see the repository).',
    },
    how_to_get: {
      official: 'https://github.com/facebookresearch/esm',
      install:
        'pip install "fair-esm[esmfold]" with the extra dependencies its README lists, or the ' +
        'Hugging Face transformers port (model facebook/esmfold_v1). The original repository is no ' +
        'longer actively developed; see official docs for the current route.',
    },
    proof_artifacts: [
      'The PDB for each sequence, with pLDDT in the B-factor column',
      'Mean pLDDT and pTM for each sequence',
      'The input FASTA with SHA-256',
      'The package and model versions (fair-esm or transformers, and the model name), the chunk size, and GPU or CPU',
      'The script used',
    ],
    how_to_verify:
      'Re-run the same sequences with the same model and compare. ' + STRUCTURE_TOLERANCE,
  },

  /* ------------------------------------------------ molecular dynamics */
  {
    id: 'openmm',
    name: 'OpenMM',
    category: 'molecular-dynamics',
    what_it_is_for:
      'Molecular dynamics from Python: the stability of a predicted structure, binding, ' +
      'conformational change, free energies.',
    needs: {
      gpu: 'optional',
      memory: 'Modest for a small protein in water; grows with the system.',
      disk: 'Trajectories grow with length and save interval, often to GB.',
      licence: 'Open source (MIT, with LGPL parts); see the documentation.',
    },
    how_to_get: {
      official: 'https://openmm.org',
      install:
        'conda install -c conda-forge openmm (the route the documentation recommends) or ' +
        'pip install openmm; check it with python -m openmm.testInstallation. The CUDA and OpenCL ' +
        'platforms use a GPU; the CPU platform works, slowly.',
    },
    proof_artifacts: [
      'The starting structure (PDB or mmCIF) and every parameter file, with SHA-256',
      'The complete simulation script: force field and water model, box and ions, integrator, timestep, temperature, pressure, constraints and run length',
      "The random seeds (the integrator's and the initial velocities')",
      'The OpenMM version, the platform (CUDA, OpenCL, CPU or Reference) and its precision',
      'The state log (energy, temperature, volume), the final structure, and the trajectory (DCD or XTC) or its SHA-256 and where it is kept',
      'The analysis script and its outputs (RMSD, RMSF, radius of gyration …)',
    ],
    how_to_verify:
      'Molecular dynamics is chaotic: two runs diverge within picoseconds unless platform, ' +
      'precision and seeds are identical, so do not expect the same trajectory. Re-run from the ' +
      'same inputs, or run replicas with new seeds, and compare the observables the claim rests ' +
      "on: averages and distributions within their statistical error across replicas, or the " +
      "task's tolerance. Check the energy and temperature logs for a stable, equilibrated run.",
  },
  {
    id: 'gromacs',
    name: 'GROMACS',
    category: 'molecular-dynamics',
    what_it_is_for:
      'High-performance molecular dynamics of proteins, lipids and nucleic acids, with a large ' +
      'set of analysis tools.',
    needs: {
      gpu: 'optional',
      memory: 'Modest for small systems; grows with the system.',
      disk: 'Trajectories, often GB.',
      licence: 'LGPL 2.1.',
    },
    how_to_get: {
      official: 'https://www.gromacs.org',
      install:
        'Build from source with CMake as the installation guide in the manual describes ' +
        '(https://manual.gromacs.org), or use packages from your distribution or conda; see ' +
        'official docs for GPU builds.',
    },
    proof_artifacts: [
      'The .mdp parameter files, the topology (.top and .itp) and the starting coordinates, with SHA-256',
      'The run input (.tpr), with SHA-256',
      'The exact gmx grompp and gmx mdrun commands',
      'The gmx --version output (version, precision, GPU support)',
      'md.log, the energy file (.edr), and the trajectory (.xtc) or its SHA-256 and where it is kept',
      'The analysis commands and their outputs (gmx rms, gmx gyrate …)',
    ],
    how_to_verify:
      'Rebuild the .tpr with gmx grompp from the same inputs and compare it with the submitted ' +
      'one (gmx check -s1 a.tpr -s2 b.tpr). Bitwise-identical trajectories need the same build, ' +
      'the same hardware and mdrun -reprod; otherwise compare the observables statistically, as ' +
      'for openmm.',
  },

  /* ----------------------------------------------------- visualisation */
  {
    id: 'molstar',
    name: 'Mol* (Molstar)',
    category: 'visualisation',
    what_it_is_for:
      '3D visualisation of structures and predicted models in a web browser: colour by pLDDT, ' +
      'compare models, show interfaces and pockets. The viewer RCSB PDB and PDBe use.',
    needs: {
      gpu: 'no',
      memory: 'A web browser with WebGL.',
      disk: 'None beyond the structure files.',
      licence: 'MIT.',
    },
    how_to_get: {
      official: 'https://molstar.org',
      install:
        'Nothing to install: open https://molstar.org/viewer/ and load a PDB or mmCIF file. For ' +
        'pages of your own, the npm package molstar.',
    },
    proof_artifacts: [
      'The structure files shown, with SHA-256',
      'A Mol* session file (Download Session), so a checker opens exactly the same view',
      'An image (PNG) of each figure the claim uses, saying what it shows',
      'Which chains, residues and colouring each figure uses',
    ],
    how_to_verify:
      'Open the submitted structure and session in the viewer, and check that each figure shows ' +
      'what the claim says: the same chains and residues, coloured by the stated property. A ' +
      'picture supports a claim; its numbers must come from the files.',
  },
  {
    id: 'pymol',
    name: 'PyMOL',
    category: 'visualisation',
    what_it_is_for:
      'Structure visualisation and scripted analysis: superposition (align, super), RMSD, ' +
      'distances, figures.',
    needs: {
      gpu: 'no',
      memory: 'Modest.',
      disk: 'Small.',
      licence:
        "Open-source PyMOL has a permissive licence; incentive PyMOL is Schrödinger's paid build " +
        '(see pymol.org).',
    },
    how_to_get: {
      official: 'https://pymol.org',
      install:
        'Open-source PyMOL: conda install -c conda-forge pymol-open-source ' +
        '(source: https://github.com/schrodinger/pymol-open-source).',
    },
    proof_artifacts: [
      'The .pml (or Python) script that makes each figure and number, and the structure files with SHA-256',
      'The session file (.pse)',
      'An image (PNG) of each figure the claim uses',
      'The printed output of each alignment: RMSD and the number of atoms aligned',
      'The PyMOL version',
    ],
    how_to_verify:
      'Run the submitted script on the same files and compare RMSD and atom counts to the reported ' +
      'precision. align and super report RMSD after rejecting outliers by default, so compare like ' +
      'with like.',
  },

  /* ---------------------------------------------------------- genetics */
  {
    id: 'magma',
    name: 'MAGMA',
    category: 'genetics',
    what_it_is_for:
      'Gene and gene-set analysis of GWAS results: which genes and pathways carry an association ' +
      'signal.',
    needs: {
      gpu: 'no',
      memory: 'Modest; see official docs.',
      disk: 'A few GB for the reference data.',
      licence: 'See the official site for the terms of use.',
    },
    how_to_get: {
      official: 'https://cncr.nl/research/magma/',
      install:
        'Download the binary for your platform, the gene locations and the reference data (for ' +
        'example the 1000 Genomes European panel) from the official site; no build needed.',
    },
    proof_artifacts: [
      'The MAGMA version (the first lines of each .log)',
      'The exact commands: annotation, gene analysis and gene-set analysis',
      'The names, versions and SHA-256 of the gene locations, the reference panel and the GWAS summary statistics',
      'The .log, .genes.out and .gsa.out files',
      'The gene-set definitions and how they were built',
      'The random seed, if a model used permutations',
    ],
    how_to_verify:
      'Re-run the same commands with the same version, reference data and seed: the numbers ' +
      "should match to the printed precision, or the task's tolerance. Check the .log for the " +
      'SNPs and genes dropped, and that the sample size and gene window are the ones claimed.',
  },
  {
    id: 'plink',
    name: 'PLINK',
    category: 'genetics',
    what_it_is_for:
      'Genotype data handling and association analysis: quality control, filtering, principal ' +
      'components, linkage disequilibrium, GWAS.',
    needs: {
      gpu: 'no',
      memory: 'Depends on the dataset; --memory caps it.',
      disk: 'Genotype files, often GB.',
      licence: 'GPLv3.',
    },
    how_to_get: {
      official: 'https://www.cog-genomics.org/plink/2.0/',
      install:
        'Download the binary for your platform from the official site (PLINK 1.9 is at ' +
        'https://www.cog-genomics.org/plink/1.9/).',
    },
    proof_artifacts: [
      'The PLINK version and the exact command line, both as the .log records them',
      'SHA-256 of the genotype files (.bed/.bim/.fam or .pgen/.pvar/.psam) and of any phenotype and covariate files',
      'The .log and the output files',
      'The --seed value, if a step is randomised',
    ],
    how_to_verify:
      'Re-run the logged command with the same PLINK build on inputs whose SHA-256 match: the ' +
      'outputs should be identical. Check that the sample and variant counts in the log match ' +
      'the claim.',
  },

  /* ------------------------------------------------------ data analysis */
  {
    id: 'python-scientific',
    name: 'Python scientific stack',
    category: 'data-analysis',
    what_it_is_for:
      'Data analysis and reconciliation: downloading, joining and comparing tables across ' +
      'releases or sources; statistics and plots (NumPy, SciPy, pandas, statsmodels, ' +
      'scikit-learn, matplotlib).',
    needs: {
      gpu: 'no',
      memory: 'Depends on the data.',
      disk: 'Depends on the data.',
      licence: 'Open source, mostly BSD-style licences.',
    },
    how_to_get: {
      official: 'https://www.python.org',
      install:
        'python -m venv .venv, then pip install numpy scipy pandas statsmodels scikit-learn ' +
        'matplotlib (https://numpy.org, https://scipy.org, https://pandas.pydata.org), or the ' +
        'conda-forge packages. Pin the versions you use.',
    },
    proof_artifacts: [
      'The script or notebook',
      'The environment: the Python version and pip freeze (or conda env export) output',
      HASHES,
      'The random seeds',
      'The output tables, with SHA-256',
    ],
    how_to_verify:
      'Recreate the environment from the lock, re-run on inputs whose SHA-256 match, and compare: ' +
      "identical tables for deterministic steps, numbers within the task's tolerance otherwise " +
      '(UAIN\'s default for floating point: 1e-9 relative). For a reconciliation, also trace a ' +
      'random sample of rows back to the raw sources by hand.',
  },
  {
    id: 'r-bioconductor',
    name: 'R and Bioconductor',
    category: 'data-analysis',
    what_it_is_for:
      'Statistics and genomics in R: differential expression, survival analysis, annotation.',
    needs: {
      gpu: 'no',
      memory: 'Depends on the data.',
      disk: 'Depends on the data and the packages.',
      licence: 'R: GPL-2 or GPL-3. Bioconductor packages: open source, licence per package.',
    },
    how_to_get: {
      official: 'https://bioconductor.org',
      install:
        'R from CRAN (https://cran.r-project.org), then install.packages("BiocManager") and ' +
        'BiocManager::install(...).',
      container: 'bioconductor/bioconductor_docker, one tag per Bioconductor release (see bioconductor.org).',
    },
    proof_artifacts: [
      'The R script, or the R Markdown or Quarto file',
      'sessionInfo() output and the Bioconductor version (BiocManager::version()), or an renv.lock',
      HASHES,
      'The set.seed() values',
      'The output tables, with SHA-256',
    ],
    how_to_verify:
      'Restore the environment (renv::restore(), or the same Bioconductor container tag), re-run, ' +
      'and compare as for python-scientific.',
  },
  {
    id: 'jupyter',
    name: 'Jupyter',
    category: 'data-analysis',
    what_it_is_for:
      'Notebooks that keep code, outputs and narrative together, so a checker can re-execute the ' +
      'whole analysis.',
    needs: {
      gpu: 'no',
      memory: 'Depends on the analysis.',
      disk: 'Small.',
      licence: 'BSD-3-Clause.',
    },
    how_to_get: {
      official: 'https://jupyter.org',
      install: 'pip install jupyterlab (or notebook), in the same environment as the analysis.',
    },
    proof_artifacts: [
      'The executed notebook (.ipynb), with its outputs',
      'The environment lock, as for python-scientific or r-bioconductor',
      HASHES,
      'Evidence it runs top to bottom: executed with jupyter nbconvert --to notebook --execute in a fresh kernel',
    ],
    how_to_verify:
      'Re-execute it in a clean kernel (jupyter nbconvert --to notebook --execute) and compare the ' +
      'outputs. Out-of-order execution counts in the submitted notebook are a warning sign.',
  },

  /* -------------------------------------------------- hardware design */
  {
    id: 'verilator',
    name: 'Verilator',
    category: 'hardware-design',
    what_it_is_for:
      'Fast cycle-accurate simulation of Verilog and SystemVerilog designs: functional checks ' +
      'and cycle counts.',
    needs: {
      gpu: 'no',
      memory: 'Modest; large designs need more to compile.',
      disk: 'Small.',
      licence: 'LGPL-3.0 or Artistic-2.0, at your choice.',
    },
    how_to_get: {
      official: 'https://www.veripool.org/verilator/',
      install:
        'Distribution packages exist but are often old; build from source ' +
        '(https://github.com/verilator/verilator) as the guide at https://verilator.org/guide/latest/ ' +
        'describes.',
    },
    proof_artifacts: [
      'The RTL and the testbench, by git commit or with SHA-256',
      'The verilator --version output',
      'The exact verilator command, its flags, and the build commands',
      'The simulation log and results (cycle counts, pass or fail), and waveforms (VCD or FST) when the claim rests on timing',
      'The seeds of any randomised stimulus',
    ],
    how_to_verify:
      'Rebuild with the same Verilator version and flags, and run the same testbench and seeds: ' +
      'the simulation is deterministic, so results and cycle counts must match exactly.',
  },
  {
    id: 'openlane',
    name: 'OpenLane',
    category: 'hardware-design',
    what_it_is_for:
      'The open RTL-to-GDSII flow: synthesis, placement, routing and sign-off checks (DRC, LVS, ' +
      'static timing) with open process design kits such as SkyWater sky130.',
    needs: {
      gpu: 'no',
      memory: 'Several GB for small designs, more as designs grow.',
      disk: 'The tool image and a PDK take many GB; see official docs.',
      licence: 'Apache 2.0, as are the open sky130 and GF180MCU PDKs.',
    },
    how_to_get: {
      official: 'https://github.com/The-OpenROAD-Project/OpenLane',
      install:
        'It runs in Docker: the repository fetches the image and the PDK, as the documentation ' +
        '(https://openlane.readthedocs.io) describes. Successor flows have their own docs; see ' +
        'official docs for the current version.',
    },
    proof_artifacts: [
      'The design configuration (config.json or config.tcl) and the RTL, by git commit or with SHA-256',
      'The OpenLane version or image digest, and the PDK and its version (commit)',
      'The final reports: timing (setup and hold slack), area, utilisation, DRC and LVS',
      'The final GDS, with SHA-256',
      'The flow logs',
    ],
    how_to_verify:
      'Re-run the flow with the same configuration, OpenLane version and PDK version: DRC and LVS ' +
      'must come out as clean as reported, and timing and area match. Without the compute, inspect ' +
      'the submitted reports against the claim.',
  },

  /* ---------------------------------------------------- sequence search */
  {
    id: 'blast',
    name: 'NCBI BLAST+',
    category: 'sequence-search',
    what_it_is_for:
      'Sequence similarity search: homologues of a protein or nucleotide sequence, and whether a ' +
      'sequence is new.',
    needs: {
      gpu: 'no',
      memory: 'Modest for small databases; the large ones (nr, nt) need much more.',
      disk: 'Large public databases take hundreds of GB; searching them remotely needs none.',
      licence: "Public domain software from NCBI (see its documentation); databases carry their sources' terms.",
    },
    how_to_get: {
      official: 'https://blast.ncbi.nlm.nih.gov',
      install:
        'Binaries from https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/; the manual is ' +
        'at https://www.ncbi.nlm.nih.gov/books/NBK279690/.',
      container: "ncbi/blast on Docker Hub (see NCBI's BLAST+ Docker documentation).",
    },
    proof_artifacts: [
      'The program and its version (blastp -version, and so on)',
      'The exact command: database, -evalue, -max_target_seqs, -outfmt and any filters',
      'The database name and its version or date (for example blastdbcmd -db nr -info)',
      'The query FASTA, with SHA-256',
      'The tabular output (-outfmt 6 or 7)',
    ],
    how_to_verify:
      'Re-run the command against the same database version: hits and E-values should match. ' +
      'Public databases change often, so a re-run against a later release is compared by its top ' +
      'hits, not exactly.',
  },
];

const BY_ID = new Map(TOOL_CATALOG.map((t) => [t.id, t]));

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  ...new Set(TOOL_CATALOG.map((t) => t.category)),
];

/** One entry by id, or null. Ids are case-insensitive. */
export const toolById = (id: unknown): ToolEntry | null =>
  BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;

/**
 * How a result made with any tool carries its proof: the artifacts and
 * reproduction fields uain_contribute already takes (evidence/
 * artifact-evidence.ts), and the receipt uain_verify takes.
 */
export const PROOF_RULES: readonly string[] = [
  'Attach each proof file as an artifact on uain_contribute with a manifest: a public https address ' +
    'where it can be fetched, its SHA-256, its size in bytes, media type, licence and role (code, ' +
    'dataset, environment or output). UAIN records the manifest, not the bytes: keep the file available.',
  'Give the re-run as reproduction: the inputs (labels of the pinned artifacts), the exact command, ' +
    'the environment (the container image digest, or the tool and library versions), the seed, and ' +
    'the outputs a checker compares, each with its expected value and absolute_tolerance.',
  "Attach what the task's requirements.proof.artifacts asks for, and what the catalogue lists as " +
    "proof_artifacts for each tool you used. Say in the detail which tools and versions you ran.",
  'A checker re-runs what the task\'s verification.method says (reproduce, inspect, forecast-resolve ' +
    'or review) and, for a re-run, confirms with reproduction_receipt on uain_verify: outcome ' +
    'reproduced, mismatch or inaccessible. Only a reproduced receipt can confirm.',
  'Never attach credentials, private data or model parameters whose terms forbid sharing them.',
];

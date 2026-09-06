#ifndef PENPOT_WOFF_TOOLS_UNISTD_H
#define PENPOT_WOFF_TOOLS_UNISTD_H

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define O_BINARY _O_BINARY
#define fileno _fileno
#define setmode _setmode
#endif

extern char *optarg;
extern int optind;
extern int opterr;
extern int optopt;

int getopt(int argc, char *const argv[], const char *options);

#endif

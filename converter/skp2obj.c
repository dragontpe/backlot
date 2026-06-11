/*
 * skp2obj — convert SketchUp .skp to OBJ + MTL + textures
 *
 * Links against SketchUpAPI.framework shipped inside the installed
 * SketchUp app bundle (no Trimble SDK download needed). API signatures
 * are declared here by hand from the public C API documentation.
 *
 * Usage: skp2obj <input.skp> <output-dir>
 * Output: <output-dir>/model.obj, model.mtl, textures/
 *
 * Coordinate handling: SketchUp is inches, Z-up. Output is meters, Y-up
 * (x, z, -y) to match three.js conventions.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>

/* ---- SketchUp C API declarations (hand-written, no SDK headers) ---- */

typedef int SUResult; /* SU_ERROR_NONE == 0 */
#define SU_OK 0

#define DECL_REF(name) typedef struct { void *ptr; } name
DECL_REF(SUModelRef);
DECL_REF(SUEntitiesRef);
DECL_REF(SUFaceRef);
DECL_REF(SUGroupRef);
DECL_REF(SUComponentInstanceRef);
DECL_REF(SUComponentDefinitionRef);
DECL_REF(SUMeshHelperRef);
DECL_REF(SUMaterialRef);
DECL_REF(SUTextureRef);
DECL_REF(SUStringRef);
DECL_REF(SUDrawingElementRef);

typedef struct { double x, y, z; } SUPoint3D;
typedef struct { double x, y, z; } SUVector3D;
typedef struct { double values[16]; } SUTransformation;
typedef struct { unsigned char red, green, blue, alpha; } SUColor;

extern void SUInitialize(void);
extern void SUTerminate(void);
extern SUResult SUModelCreateFromFileWithStatus(SUModelRef*, const char*, int*);
extern SUResult SUModelRelease(SUModelRef*);
extern SUResult SUModelGetEntities(SUModelRef, SUEntitiesRef*);

extern SUResult SUEntitiesGetNumFaces(SUEntitiesRef, size_t*);
extern SUResult SUEntitiesGetFaces(SUEntitiesRef, size_t, SUFaceRef[], size_t*);
extern SUResult SUEntitiesGetNumGroups(SUEntitiesRef, size_t*);
extern SUResult SUEntitiesGetGroups(SUEntitiesRef, size_t, SUGroupRef[], size_t*);
extern SUResult SUEntitiesGetNumInstances(SUEntitiesRef, size_t*);
extern SUResult SUEntitiesGetInstances(SUEntitiesRef, size_t, SUComponentInstanceRef[], size_t*);

extern SUResult SUGroupGetEntities(SUGroupRef, SUEntitiesRef*);
extern SUResult SUGroupGetTransform(SUGroupRef, SUTransformation*);
extern SUResult SUComponentInstanceGetDefinition(SUComponentInstanceRef, SUComponentDefinitionRef*);
extern SUResult SUComponentInstanceGetTransform(SUComponentInstanceRef, SUTransformation*);
extern SUResult SUComponentDefinitionGetEntities(SUComponentDefinitionRef, SUEntitiesRef*);

extern SUDrawingElementRef SUFaceToDrawingElement(SUFaceRef);
extern SUDrawingElementRef SUGroupToDrawingElement(SUGroupRef);
extern SUDrawingElementRef SUComponentInstanceToDrawingElement(SUComponentInstanceRef);
extern SUResult SUDrawingElementGetHidden(SUDrawingElementRef, _Bool*);
extern SUResult SUDrawingElementGetMaterial(SUDrawingElementRef, SUMaterialRef*);

extern SUResult SUMeshHelperCreate(SUMeshHelperRef*, SUFaceRef);
extern SUResult SUMeshHelperRelease(SUMeshHelperRef*);
extern SUResult SUMeshHelperGetNumVertices(SUMeshHelperRef, size_t*);
extern SUResult SUMeshHelperGetVertices(SUMeshHelperRef, size_t, SUPoint3D[], size_t*);
extern SUResult SUMeshHelperGetNormals(SUMeshHelperRef, size_t, SUVector3D[], size_t*);
extern SUResult SUMeshHelperGetFrontSTQCoords(SUMeshHelperRef, size_t, SUPoint3D[], size_t*);
extern SUResult SUMeshHelperGetNumTriangles(SUMeshHelperRef, size_t*);
extern SUResult SUMeshHelperGetVertexIndices(SUMeshHelperRef, size_t, size_t[], size_t*);

extern SUResult SUFaceGetFrontMaterial(SUFaceRef, SUMaterialRef*);
extern SUResult SUFaceGetBackMaterial(SUFaceRef, SUMaterialRef*);
extern SUResult SUMaterialGetName(SUMaterialRef, SUStringRef*);
extern SUResult SUMaterialGetColor(SUMaterialRef, SUColor*);
extern SUResult SUMaterialGetTexture(SUMaterialRef, SUTextureRef*);
extern SUResult SUMaterialGetOpacity(SUMaterialRef, double*);
extern SUResult SUMaterialGetUseOpacity(SUMaterialRef, _Bool*);
extern SUResult SUTextureWriteToFile(SUTextureRef, const char*);
extern SUResult SUTextureGetFileName(SUTextureRef, SUStringRef*);

extern SUResult SUStringCreate(SUStringRef*);
extern SUResult SUStringGetUTF8Length(SUStringRef, size_t*);
extern SUResult SUStringGetUTF8(SUStringRef, size_t, char*, size_t*);
extern SUResult SUStringRelease(SUStringRef*);

/* ---- conversion state ---- */

#define INCH_TO_M 0.0254

typedef struct {
    void *su_ptr;            /* SUMaterialRef.ptr, identity key */
    char mtl_name[128];      /* sanitized unique name */
    char tex_file[256];      /* relative path of written texture, or "" */
    SUColor color;
    double opacity;
    int has_opacity;
} Material;

static Material g_mats[4096];
static size_t g_num_mats = 0;
static char g_outdir[1024];

static FILE *g_obj, *g_mtl;
static size_t g_voffset = 1;          /* OBJ indices are 1-based, global */
static long long g_tris = 0, g_faces = 0, g_skipped_faces = 0;
static int g_cur_mat = -2;            /* current usemtl, -2 = none yet */
static double g_min[3] = {1e30,1e30,1e30}, g_max[3] = {-1e30,-1e30,-1e30};

/* ---- helpers ---- */

static int su_string_to_buf(SUStringRef s, char *buf, size_t buflen) {
    size_t len = 0, copied = 0;
    SUStringGetUTF8Length(s, &len);
    if (len + 1 > buflen) len = buflen - 1;
    SUStringGetUTF8(s, len + 1, buf, &copied);
    buf[copied] = '\0';
    return (int)copied;
}

static void sanitize(char *s) {
    for (char *p = s; *p; p++)
        if (*p == ' ' || *p == '\t' || *p == '#' || *p == '/' || *p == '\\' ||
            *p == '*' || *p == '[' || *p == ']' || *p == '(' || *p == ')')
            *p = '_';
}

/* Register a material (by ref identity), writing its texture on first sight.
 * Returns index into g_mats, or -1 for "no material". */
static int register_material(SUMaterialRef mat) {
    if (!mat.ptr) return -1;
    for (size_t i = 0; i < g_num_mats; i++)
        if (g_mats[i].su_ptr == mat.ptr) return (int)i;
    if (g_num_mats >= 4096) return -1;

    Material *m = &g_mats[g_num_mats];
    memset(m, 0, sizeof *m);
    m->su_ptr = mat.ptr;
    m->color = (SUColor){204, 204, 204, 255};
    m->opacity = 1.0;

    char name[96] = "mat";
    SUStringRef s = {0}; SUStringCreate(&s);
    if (SUMaterialGetName(mat, &s) == SU_OK) su_string_to_buf(s, name, sizeof name);
    if (s.ptr) SUStringRelease(&s);
    sanitize(name);
    snprintf(m->mtl_name, sizeof m->mtl_name, "m%zu_%s", g_num_mats, name);

    SUMaterialGetColor(mat, &m->color);
    _Bool use_op = 0;
    if (SUMaterialGetUseOpacity(mat, &use_op) == SU_OK && use_op) {
        if (SUMaterialGetOpacity(mat, &m->opacity) == SU_OK) m->has_opacity = 1;
    }

    SUTextureRef tex = {0};
    if (SUMaterialGetTexture(mat, &tex) == SU_OK && tex.ptr) {
        /* keep original extension so image decoders aren't lied to */
        char orig[256] = "t.png";
        SUStringRef ts = {0}; SUStringCreate(&ts);
        if (SUTextureGetFileName(tex, &ts) == SU_OK) su_string_to_buf(ts, orig, sizeof orig);
        if (ts.ptr) SUStringRelease(&ts);
        const char *ext = strrchr(orig, '.');
        if (!ext || strlen(ext) > 5) ext = ".png";

        char rel[256], abs[1300];
        snprintf(rel, sizeof rel, "textures/%s%s", m->mtl_name, ext);
        snprintf(abs, sizeof abs, "%s/%s", g_outdir, rel);
        if (SUTextureWriteToFile(tex, abs) == SU_OK)
            strncpy(m->tex_file, rel, sizeof m->tex_file - 1);
    }

    return (int)g_num_mats++;
}

/* ---- transform math (column-major 4x4, translation in values[12..14]) ---- */

static void mat_mul(const double a[16], const double b[16], double out[16]) {
    for (int c = 0; c < 4; c++)
        for (int r = 0; r < 4; r++) {
            double v = 0;
            for (int k = 0; k < 4; k++) v += a[k*4 + r] * b[c*4 + k];
            out[c*4 + r] = v;
        }
}

static void xform_point(const double m[16], const SUPoint3D *p, double out[3]) {
    out[0] = m[0]*p->x + m[4]*p->y + m[8]*p->z  + m[12];
    out[1] = m[1]*p->x + m[5]*p->y + m[9]*p->z  + m[13];
    out[2] = m[2]*p->x + m[6]*p->y + m[10]*p->z + m[14];
}

static double det3(const double m[16]) {
    return m[0] * (m[5] * m[10] - m[9] * m[6])
         - m[4] * (m[1] * m[10] - m[9] * m[2])
         + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

static void xform_normal(const double m[16], const SUVector3D *n, double out[3]) {
    out[0] = m[0]*n->x + m[4]*n->y + m[8]*n->z;
    out[1] = m[1]*n->x + m[5]*n->y + m[9]*n->z;
    out[2] = m[2]*n->x + m[6]*n->y + m[10]*n->z;
    double l = sqrt(out[0]*out[0] + out[1]*out[1] + out[2]*out[2]);
    if (l > 1e-12) { out[0]/=l; out[1]/=l; out[2]/=l; }
}

/* ---- face emission ---- */

static void emit_face(SUFaceRef face, const double xf[16], int inherited_mat) {
    _Bool hidden = 0;
    SUDrawingElementGetHidden(SUFaceToDrawingElement(face), &hidden);
    if (hidden) return;

    SUMaterialRef mat = {0};
    SUFaceGetFrontMaterial(face, &mat);
    if (!mat.ptr) SUFaceGetBackMaterial(face, &mat);
    int mi = mat.ptr ? register_material(mat) : inherited_mat;

    SUMeshHelperRef mh = {0};
    if (SUMeshHelperCreate(&mh, face) != SU_OK) { g_skipped_faces++; return; }

    size_t nv = 0, nt = 0;
    SUMeshHelperGetNumVertices(mh, &nv);
    SUMeshHelperGetNumTriangles(mh, &nt);
    if (nv == 0 || nt == 0) { SUMeshHelperRelease(&mh); g_skipped_faces++; return; }

    SUPoint3D *verts = malloc(nv * sizeof *verts);
    SUVector3D *norms = malloc(nv * sizeof *norms);
    SUPoint3D *stq   = malloc(nv * sizeof *stq);
    size_t *idx      = malloc(nt * 3 * sizeof *idx);
    size_t got = 0;

    SUMeshHelperGetVertices(mh, nv, verts, &got);
    SUMeshHelperGetNormals(mh, nv, norms, &got);
    SUMeshHelperGetFrontSTQCoords(mh, nv, stq, &got);
    SUMeshHelperGetVertexIndices(mh, nt * 3, idx, &got);
    SUMeshHelperRelease(&mh);

    for (size_t i = 0; i < nv; i++) {
        double p[3], n[3];
        xform_point(xf, &verts[i], p);
        xform_normal(xf, &norms[i], n);
        /* inches Z-up -> meters Y-up */
        double x = p[0]*INCH_TO_M, y = p[2]*INCH_TO_M, z = -p[1]*INCH_TO_M;
        if (x < g_min[0]) g_min[0] = x; if (x > g_max[0]) g_max[0] = x;
        if (y < g_min[1]) g_min[1] = y; if (y > g_max[1]) g_max[1] = y;
        if (z < g_min[2]) g_min[2] = z; if (z > g_max[2]) g_max[2] = z;
        double q = (fabs(stq[i].z) > 1e-12) ? stq[i].z : 1.0;
        fprintf(g_obj, "v %.6f %.6f %.6f\nvt %.6f %.6f\nvn %.4f %.4f %.4f\n",
                x, y, z, stq[i].x / q, stq[i].y / q, n[0], n[2], -n[1]);
    }

    if (mi != g_cur_mat) {
        fprintf(g_obj, "usemtl %s\n", mi >= 0 ? g_mats[mi].mtl_name : "default");
        g_cur_mat = mi;
    }
    /* Mirrored instances (negative determinant) flip triangle winding but
     * not normals; swap two indices so winding stays consistent with the
     * transformed normals, or lighting inverts on mirrored geometry. */
    int mirrored = det3(xf) < 0.0;
    for (size_t t = 0; t < nt; t++) {
        size_t a = g_voffset + idx[t*3], b = g_voffset + idx[t*3+1], c = g_voffset + idx[t*3+2];
        if (mirrored) { size_t tmp = b; b = c; c = tmp; }
        fprintf(g_obj, "f %zu/%zu/%zu %zu/%zu/%zu %zu/%zu/%zu\n", a,a,a, b,b,b, c,c,c);
    }

    g_voffset += nv;
    g_tris += (long long)nt;
    g_faces++;
    free(verts); free(norms); free(stq); free(idx);
}

/* ---- recursive traversal ---- */

static void walk(SUEntitiesRef ents, const double xf[16], int inherited_mat, int depth) {
    if (depth > 64) return;

    size_t n = 0;
    SUEntitiesGetNumFaces(ents, &n);
    if (n) {
        SUFaceRef *faces = malloc(n * sizeof *faces);
        size_t got = 0;
        SUEntitiesGetFaces(ents, n, faces, &got);
        for (size_t i = 0; i < got; i++) emit_face(faces[i], xf, inherited_mat);
        free(faces);
    }

    SUEntitiesGetNumGroups(ents, &n);
    if (n) {
        SUGroupRef *groups = malloc(n * sizeof *groups);
        size_t got = 0;
        SUEntitiesGetGroups(ents, n, groups, &got);
        for (size_t i = 0; i < got; i++) {
            SUDrawingElementRef de = SUGroupToDrawingElement(groups[i]);
            _Bool hidden = 0;
            SUDrawingElementGetHidden(de, &hidden);
            if (hidden) continue;
            SUMaterialRef gm = {0};
            SUDrawingElementGetMaterial(de, &gm);
            int mi = gm.ptr ? register_material(gm) : inherited_mat;
            SUTransformation t; SUGroupGetTransform(groups[i], &t);
            double combined[16]; mat_mul(xf, t.values, combined);
            SUEntitiesRef child = {0};
            if (SUGroupGetEntities(groups[i], &child) == SU_OK)
                walk(child, combined, mi, depth + 1);
        }
        free(groups);
    }

    SUEntitiesGetNumInstances(ents, &n);
    if (n) {
        SUComponentInstanceRef *insts = malloc(n * sizeof *insts);
        size_t got = 0;
        SUEntitiesGetInstances(ents, n, insts, &got);
        for (size_t i = 0; i < got; i++) {
            SUDrawingElementRef de = SUComponentInstanceToDrawingElement(insts[i]);
            _Bool hidden = 0;
            SUDrawingElementGetHidden(de, &hidden);
            if (hidden) continue;
            SUMaterialRef im = {0};
            SUDrawingElementGetMaterial(de, &im);
            int mi = im.ptr ? register_material(im) : inherited_mat;
            SUComponentDefinitionRef def = {0};
            if (SUComponentInstanceGetDefinition(insts[i], &def) != SU_OK || !def.ptr) continue;
            SUTransformation t; SUComponentInstanceGetTransform(insts[i], &t);
            double combined[16]; mat_mul(xf, t.values, combined);
            SUEntitiesRef child = {0};
            if (SUComponentDefinitionGetEntities(def, &child) == SU_OK)
                walk(child, combined, mi, depth + 1);
        }
        free(insts);
    }
}

/* ---- main ---- */

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: skp2obj <input.skp> <output-dir>\n");
        return 2;
    }
    const char *in = argv[1];
    snprintf(g_outdir, sizeof g_outdir, "%s", argv[2]);

    char path[1400];
    mkdir(g_outdir, 0755);
    snprintf(path, sizeof path, "%s/textures", g_outdir);
    mkdir(path, 0755);

    SUInitialize();

    SUModelRef model = {0};
    int load_status = 0;
    SUResult res = SUModelCreateFromFileWithStatus(&model, in, &load_status);
    if (res != SU_OK) {
        fprintf(stderr, "ERROR: failed to load %s (SUResult=%d, status=%d)\n", in, res, load_status);
        return 1;
    }
    fprintf(stderr, "loaded model (status=%d)\n", load_status);

    snprintf(path, sizeof path, "%s/model.obj", g_outdir);
    g_obj = fopen(path, "w");
    snprintf(path, sizeof path, "%s/model.mtl", g_outdir);
    g_mtl = fopen(path, "w");
    if (!g_obj || !g_mtl) { fprintf(stderr, "ERROR: cannot open output files\n"); return 1; }

    fprintf(g_obj, "mtllib model.mtl\n");

    SUEntitiesRef ents = {0};
    SUModelGetEntities(model, &ents);
    double identity[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
    walk(ents, identity, -1, 0);

    /* MTL: default + everything registered during the walk */
    fprintf(g_mtl, "newmtl default\nKd 0.8 0.8 0.8\n");
    for (size_t i = 0; i < g_num_mats; i++) {
        Material *m = &g_mats[i];
        fprintf(g_mtl, "\nnewmtl %s\nKd %.4f %.4f %.4f\n", m->mtl_name,
                m->color.red / 255.0, m->color.green / 255.0, m->color.blue / 255.0);
        if (m->has_opacity && m->opacity < 0.999) fprintf(g_mtl, "d %.4f\n", m->opacity);
        if (m->tex_file[0]) fprintf(g_mtl, "map_Kd %s\n", m->tex_file);
    }

    fclose(g_obj);
    fclose(g_mtl);
    SUModelRelease(&model);
    SUTerminate();

    fprintf(stderr,
        "done: %lld faces -> %lld triangles, %zu vertices, %zu materials, %lld skipped\n"
        "bbox (m): x[%.2f..%.2f] y[%.2f..%.2f] z[%.2f..%.2f]\n",
        g_faces, g_tris, g_voffset - 1, g_num_mats, g_skipped_faces,
        g_min[0], g_max[0], g_min[1], g_max[1], g_min[2], g_max[2]);
    return 0;
}
